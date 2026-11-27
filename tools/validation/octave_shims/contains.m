function tf = contains(str, pattern)
% Minimal stand-in for MATLAB's contains(str, pattern) for char arrays (MFeval's readTIR uses it once, to look for a carriage return).
% GNU Octave 8 does not provide it. Apache-2.0, part of OpenGrid.
  tf = ~isempty(strfind(str, pattern));
end
