# Release Checklist

This checklist applies to beta releases of TIPICA Webapp.

## Repository state

- Run `git log -1 --oneline --decorate`.
- Run `git describe --tags --always --dirty`.
- Confirm `package.json` and `package-lock.json` have the intended identical version.
- Run `git status --short` and confirm only intended files are modified.

## Validation and build

- Run `git diff --check`.
- Run `npm install` when dependencies or lockfile provenance require it.
- Run `npm run build`.
- Run `npm run smoke:fitting-parity`.
- Run `npm run smoke:plate-configurator`.
- Run `npm run smoke:configurator-persistence`.
- Confirm no tracked temporary files, TypeScript build-info files, or `dist/` artifacts remain.

## Representative export checks

Generate and inspect at least:

- external calibration with unknown-only samples;
- external calibration with standard addition;
- internal calibration with standard addition;
- one sparse and one extensive empty-well arrangement when QC code changed.

For each applicable package:

- check PNG, XLSX, TXT, and JSON consistency;
- check workbook sheet numbering and `01_CONTENTS`;
- check for empty/non-applicable sheets;
- check for duplicate rows;
- check references, uncertainty, delta, and recovery;
- check Excel errors;
- confirm workflow-appropriate METHOD_COMPARISON panels and metrics.

## Documentation and metadata

- Update README and CHANGELOG.
- Update `VALIDATION_STATUS.md` without overstating parity.
- Update `CITATION.cff` version and release date.
- Confirm the public webapp, source repository, Zenodo concept DOI, and Python reference DOI.
- Confirm the release notes identify the software as beta.
- Do not retain an old version DOI as the DOI of the new version.

## Safety flags

Unless a broader audit explicitly supports changing them:

- `SAFE_TO_CLAIM_FULL_WORKFLOW_PARITY = no`
- `SAFE_TO_CLAIM_FULL_FITTING_PARITY = no`
- `SAFE_TO_CLAIM_FULL_CONFIGURATOR_PARITY = no`
- `SAFE_TO_CLAIM_FULL_IMAGE_INPUT_PARITY = no`
- `SAFE_TO_CLAIM_UNIVERSAL_XLSX_TXT_PARITY = no`
- `SAFE_TO_CLAIM_WEBAPP_DEPOSIT_EQUIVALENT_TO_PYTHON_DEPOSIT = no`

## Git release

- Commit all intended source, documentation, and version files.
- Create an annotated version tag only after the commit is final.
- Push the branch and tag.
- Verify local HEAD, `origin/master`, and the tag point to the same commit.
- Verify the working tree is clean.
- Create the GitHub Release from the existing tag and mark it as a pre-release while beta.

## Zenodo

- Confirm the GitHub repository is enabled in Zenodo.
- Publish the GitHub Release before expecting a new Zenodo archive.
- Wait for Zenodo processing to complete.
- Verify version, title, authors, license, files, related identifiers, and concept DOI relationship.
- Record the newly minted version DOI in the release record and future documentation updates.
