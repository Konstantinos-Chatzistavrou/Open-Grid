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
  isOctave = exist('OCTAVE_VERSION', 'builtin') ~= 0;
  if isOctave
    % Octave resolves "mfeval.readTIR" to the FUNCTION mfeval.m instead of the +mfeval package (MATLAB does it the other way round), so under
    % Octave only the package is put on the path (a temporary copy of the vendored, unmodified files) and its Solver is called directly: that is
    % all the six-line wrapper mfeval.m does after validating its arguments.
    addpath(fullfile(here, 'octave_shims'));
    pkgRoot = tempname();
    mkdir(pkgRoot);
    copyfile(fullfile(here, 'mfeval', '+mfeval'), fullfile(pkgRoot, '+mfeval'));
    addpath(pkgRoot);
  elseif ~exist('mfeval.m', 'file')
    addpath(fullfile(here, 'mfeval'));                    % the vendored, unmodified MFeval sources
  end
  par = mfeval.readTIR(tirFile);
  if isOctave
    solver = mfeval.Solver;
  end
  C = dlmread(casesFile, ',', 1, 0);                      % header row skipped
  n = size(C, 1);
  fz = C(:, 1) * par.FNOMIN;
  vx = C(:, 6) * par.LONGVL;
  pr = C(:, 7) * par.NOMPRES;
  pr(C(:, 7) == 0) = par.INFLPRES;
  out = nan(n, 30);
  % One point per call, on purpose. MFeval's rolling-radius loop ("while abs(Re_old - Re) > 1e-9") is vectorised: it stops as soon as ANY row has
  % converged (a standstill or zero-load row converges at once), leaving every other row at iteration 2. So Re, omega, Rl, rho and Cz of a row would
  % depend on which other rows share the call (up to ~3e-5 relative in omega). A single-row call converges properly, which is what rs::mf62 computes.
  for i = 1:n
    inp = [fz(i), C(i, 2), C(i, 3), C(i, 4), C(i, 5), vx(i), pr(i)];
    if isOctave
      out(i, :) = solver.fullSteadyState(par, inp, C(i, 8));
    else
      out(i, :) = mfeval(par, inp, C(i, 8));
    end
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
