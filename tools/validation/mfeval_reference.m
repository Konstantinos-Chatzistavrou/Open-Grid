function mfeval_reference(tirFile, casesFile, outFile)
% MFEVAL_REFERENCE  Run MFeval on the operating points of data/validation/mf62/mf62_cases.csv and write its 30 output columns to a CSV.
%
%   mfeval_reference('MagicFormula62_Parameters.tir', 'mf62_cases.csv', 'mf62_ref.csv')
%
% Works in MATLAB (with MFeval installed, or tools/validation/mfeval on the path) and in GNU Octave (the shims in tools/validation/octave_shims
% are added to the path automatically). Apache-2.0, part of OpenGrid; MFeval itself is BSD 3-Clause (tools/validation/mfeval/LICENSE.txt).
%
% cases columns: fz_rel, kappa, alpha, gamma, phit, vx_rel, p_rel, usemode. Per tyre file: fz = fz_rel*FNOMIN, vx = vx_rel*LONGVL,
% pressure = p_rel*NOMPRES, and p_rel = 0 means the file's INFLPRES (filled in here: MFeval treats a pressure column that is not all zero literally).
% The output CSV has MFeval's column order, %.17g precision, and NaN where MFeval returned NaN.
  here = fileparts(mfilename('fullpath'));
  if exist('OCTAVE_VERSION', 'builtin')
    addpath(fullfile(here, 'octave_shims'));
  end
  if ~exist('mfeval.m', 'file')
    addpath(fullfile(here, 'mfeval'));                    % the vendored, unmodified MFeval sources
  end
  par = mfeval.readTIR(tirFile);
  C = dlmread(casesFile, ',', 1, 0);                      % header row skipped
  n = size(C, 1);
  fz = C(:, 1) * par.FNOMIN;
  vx = C(:, 6) * par.LONGVL;
  pr = C(:, 7) * par.NOMPRES;
  pr(C(:, 7) == 0) = par.INFLPRES;
  out = nan(n, 30);
  modes = unique(C(:, 8));
  for k = 1:numel(modes)
    idx = (C(:, 8) == modes(k));
    inp = [fz(idx), C(idx, 2), C(idx, 3), C(idx, 4), C(idx, 5), vx(idx), pr(idx)];
    out(idx, :) = mfeval(par, inp, modes(k));
  end
  names = {'Fx','Fy','Fz','Mx','My','Mz','kappa','alpha','gamma','phit','Vx','P','Re','rho','two_a','t','mux','muy','omega','Rl','two_b','Mzr', ...
           'Cx','Cy','Cz','Kya','sigmax','sigmay','instKya','Kxk'};
  fid = fopen(outFile, 'w');
  fprintf(fid, '%s\n', strjoin(names, ','));
  for i = 1:n
    fprintf(fid, '%.17g', out(i, 1));
    fprintf(fid, ',%.17g', out(i, 2:end));
    fprintf(fid, '\n');
  end
  fclose(fid);
  fprintf('wrote %d rows (%d columns) to %s\n', n, size(out, 2), outFile);
end
