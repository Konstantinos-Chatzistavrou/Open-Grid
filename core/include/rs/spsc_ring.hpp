// Lock-free single-producer / single-consumer ring buffer (header-only, C++17, no engine dependencies).
//
// What it is for: handing data between exactly TWO threads without a lock. In the physics runtime
//   - physics thread -> render / game thread: one state snapshot per physics tick (SpscRing<StepRecord, N>)
//   - render / input thread -> physics thread: driver commands and crash impulses (SpscRing<Command, N>)
// One thread may only push, the other may only pop. A second producer or consumer is a data race.
//
// How it works (the classic Lamport ring, as in Rigtorp's SPSCQueue):
//   head_ = index of the next slot to write (written only by the producer)
//   tail_ = index of the next slot to read  (written only by the consumer)
//   Both count up forever (64-bit: never wraps in practice); slot = index & (Capacity - 1). Full when
//   head_ - tail_ == Capacity, empty when head_ == tail_. All Capacity slots are usable.
// Memory ordering:
//   producer: write the slot, then head_.store(release)  -> the consumer's head_.load(acquire) sees the whole slot
//   consumer: read the slot,  then tail_.store(release)  -> the producer's tail_.load(acquire) proves the slot was
//                                                           read before it is overwritten
// So a reader never sees a half-written slot (no tearing) and items come out in push order, none lost or doubled.
// Each side keeps a cached copy of the other side's index and only reloads it (a cache miss on the other core)
// when the cached value says full / empty. head_ and tail_ live on separate cache lines (no false sharing).
//
// Real-time use: no allocation after construction (slots are constructed once, then copy- / move-assigned), no
// syscalls, wait-free (every call finishes in a bounded number of steps). try_push fails instead of blocking when the
// ring is full: the caller decides (drop and count, or retry). The physics thread must never wait on the renderer.
#pragma once
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <type_traits>
#include <utility>

namespace rs {

// 64 bytes on x86-64 and most ARM cores. (std::hardware_destructive_interference_size is avoided on purpose: GCC
// warns that its value may differ between compiler flags, which matters for a type shared across translation units.)
constexpr std::size_t kCacheLineBytes = 64;

template <typename T, std::size_t Capacity>
class SpscRing {
    static_assert(Capacity >= 2 && (Capacity & (Capacity - 1)) == 0, "SpscRing capacity must be a power of two >= 2");
    static_assert(std::is_default_constructible<T>::value, "SpscRing slots are constructed up front");

public:
    SpscRing() : slots_(new Slot[Capacity]) {}
    SpscRing(const SpscRing&) = delete;
    SpscRing& operator=(const SpscRing&) = delete;

    static constexpr std::size_t capacity() { return Capacity; }

    // ---- producer thread only --------------------------------------------------------------------------------------
    /** Copy `v` in. False (nothing written) when the ring is full. */
    bool try_push(const T& v) {
        const std::size_t h = head_.load(std::memory_order_relaxed);
        if (!has_room(h)) return false;
        slots_[h & kMask].value = v;
        head_.store(h + 1, std::memory_order_release);
        return true;
    }
    bool try_push(T&& v) {
        const std::size_t h = head_.load(std::memory_order_relaxed);
        if (!has_room(h)) return false;
        slots_[h & kMask].value = std::move(v);
        head_.store(h + 1, std::memory_order_release);
        return true;
    }
    /**
     * Zero-copy push: fill the returned slot in place, then commit(). nullptr when full. The slot still holds whatever
     * was there before (a recycled item): overwrite every field you publish.
     */
    T* prepare() {
        const std::size_t h = head_.load(std::memory_order_relaxed);
        return has_room(h) ? &slots_[h & kMask].value : nullptr;
    }
    void commit() { head_.store(head_.load(std::memory_order_relaxed) + 1, std::memory_order_release); }

    // ---- consumer thread only --------------------------------------------------------------------------------------
    /** Move the oldest item into `out`. False when empty. */
    bool try_pop(T& out) {
        const std::size_t t = tail_.load(std::memory_order_relaxed);
        if (!has_data(t)) return false;
        out = std::move(slots_[t & kMask].value);
        tail_.store(t + 1, std::memory_order_release);
        return true;
    }
    /** The oldest item without removing it (nullptr when empty). Valid until pop() on this thread. */
    const T* front() {
        const std::size_t t = tail_.load(std::memory_order_relaxed);
        return has_data(t) ? &slots_[t & kMask].value : nullptr;
    }
    /** Remove the item front() returned. Only after front() gave non-null. */
    void pop() { tail_.store(tail_.load(std::memory_order_relaxed) + 1, std::memory_order_release); }

    // ---- either thread ---------------------------------------------------------------------------------------------
    /** Items in the ring right now. Exact on a quiet ring, a snapshot while the other thread works. */
    std::size_t size_approx() const {
        const std::size_t t = tail_.load(std::memory_order_acquire);
        const std::size_t h = head_.load(std::memory_order_acquire);
        return h >= t ? h - t : 0;
    }
    bool empty_approx() const { return size_approx() == 0; }

private:
    static constexpr std::size_t kMask = Capacity - 1;

    bool has_room(std::size_t h) {
        if (h - tail_cache_ < Capacity) return true;
        tail_cache_ = tail_.load(std::memory_order_acquire);
        return h - tail_cache_ < Capacity;
    }
    bool has_data(std::size_t t) {
        if (t != head_cache_) return true;
        head_cache_ = head_.load(std::memory_order_acquire);
        return t != head_cache_;
    }

    struct alignas(kCacheLineBytes) Slot {   // one item per cache line (or several lines for a large T)
        T value{};
    };

    // Producer-owned line: its index and its cached view of the consumer's.
    alignas(kCacheLineBytes) std::atomic<std::size_t> head_{0};
    std::size_t tail_cache_ = 0;
    // Consumer-owned line.
    alignas(kCacheLineBytes) std::atomic<std::size_t> tail_{0};
    std::size_t head_cache_ = 0;
    // Read-only after construction.
    alignas(kCacheLineBytes) std::unique_ptr<Slot[]> slots_;
};

// Latest-value exchange between one writer and one reader (a "triple buffer"), lock-free and wait-free.
// Use it where only the NEWEST value matters and the reader may skip some: the ground the game thread traced this
// frame (read by every physics step until the next frame), or the rays the physics thread wants traced next.
// The writer fills write_buffer() and publish()es; the reader calls fetch() and reads read_buffer(). Three buffers:
// one owned by each side plus one in the middle, swapped with a single atomic exchange, so neither side ever waits,
// sees a half-written value, or allocates (buffers holding vectors keep their capacity as they cycle).
template <typename T>
class TripleBuffer {
public:
    TripleBuffer() = default;
    TripleBuffer(const TripleBuffer&) = delete;
    TripleBuffer& operator=(const TripleBuffer&) = delete;

    // ---- writer thread ---------------------------------------------------------------------------------------------
    T& write_buffer() { return buf_[back_].value; }
    /** Make write_buffer() the latest value; write_buffer() then refers to a recycled buffer (old contents). */
    void publish() {
        const std::uint8_t old = middle_.exchange(static_cast<std::uint8_t>(back_ | kFresh), std::memory_order_acq_rel);
        back_ = static_cast<std::uint8_t>(old & kIndex);
    }

    // ---- reader thread ---------------------------------------------------------------------------------------------
    /** Take the newest published value if there is one; true when read_buffer() changed. */
    bool fetch() {
        if (!(middle_.load(std::memory_order_relaxed) & kFresh)) return false;
        const std::uint8_t old = middle_.exchange(front_, std::memory_order_acq_rel);
        front_ = static_cast<std::uint8_t>(old & kIndex);
        return true;
    }
    const T& read_buffer() const { return buf_[front_].value; }
    T& read_buffer() { return buf_[front_].value; }

private:
    static constexpr std::uint8_t kIndex = 0x3;
    static constexpr std::uint8_t kFresh = 0x4;
    struct alignas(kCacheLineBytes) Buf {
        T value{};
    };
    Buf buf_[3];
    alignas(kCacheLineBytes) std::atomic<std::uint8_t> middle_{1};
    alignas(kCacheLineBytes) std::uint8_t back_ = 0;    // writer-owned
    alignas(kCacheLineBytes) std::uint8_t front_ = 2;   // reader-owned
};

}  // namespace rs
