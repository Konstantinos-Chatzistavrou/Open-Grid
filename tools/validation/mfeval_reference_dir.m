function mfeval_reference_dir(tyreDir, casesFile, outDir)
% MFEVAL_REFERENCE_DIR  Run mfeval_reference on every .tir in a folder; one CSV per tyre in outDir (existing CSVs are kept, so an interrupted run resumes).
%   mfeval_reference_dir('/tmp/mf62_sweep/tyres', 'data/validation/mf62/mf62_cases.csv', '/tmp/mf62_sweep/refs')
% Used by the per-coefficient sweep (tools/validation/mf62_coefficient_sweep.mjs). Apache-2.0, part of OpenGrid.
  warning('off', 'all');
  if ~exist(outDir, 'dir'); mkdir(outDir); end
  files = dir(fullfile(tyreDir, '*.tir'));
  for i = 1:numel(files)
    [~, name] = fileparts(files(i).name);
    out = fullfile(outDir, [name '.csv']);
    if exist(out, 'file'); continue; end
    try
      evalc('mfeval_reference(fullfile(tyreDir, files(i).name), casesFile, out)');
    catch err
      fprintf('FAILED %s: %s\n', name, strtok(err.message, char(10)));
    end
    if mod(i, 25) == 0; fprintf('%d / %d tyres\n', i, numel(files)); fflush(stdout); end
  end
  fprintf('done: %d tyres\n', numel(files));
end
