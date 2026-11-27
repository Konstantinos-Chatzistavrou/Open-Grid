// The licence notice of the built-in template tyres (Project Chrono, BSD-3-Clause). The .tir files carry none themselves, but a fitted file contains their numbers wherever the data did not decide,
// and BSD-3 requires the notice to travel with them: the page prepends it, as comment lines, to the file it offers for download. tools/test_lab.mjs checks this text against data/tires/LICENSE-projectchrono.txt.
export const CHRONO_NOTICE = `Contains coefficients of a tyre file from Project Chrono (https://github.com/projectchrono/chrono), BSD-3-Clause.
Copyright (c) 2016, Project Chrono Development Team
All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

 - Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
 - Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.
 - Neither the name of the nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`;

/** `tir` with `notice` written as '$' comment lines right after the first (provenance) block of comments. */
export function withNotice(tir, notice) {
  const lines = tir.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].startsWith('$ ')) ++i;
  const block = ['$ Licence notice of the template tyre (the page adds it for its built-in templates):', ...notice.split('\n').map((l) => `$ ${l}`.trimEnd())];
  return [...lines.slice(0, i), ...block, ...lines.slice(i)].join('\n');
}
