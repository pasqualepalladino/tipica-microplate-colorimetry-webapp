# Release Checklist v0.1.0-beta

This checklist is for a truthful beta publication/release of the browser companion repository. It does not establish full Python parity.

## Pre-release checks

- Confirm the working tree is clean before final release packaging.
- Run `npm install` from the repository root.
- Run `npm run build`.
- Run `npm run smoke:fitting-parity`.
- Run `npm run smoke:plate-configurator`.
- Run `npm run smoke:configurator-persistence`.
- Run `git diff --check`.
- Confirm no tracked temporary files or build artifacts are present, especially `.tmp-fitting/`, `.tmp-smoke/`, `.tmp-configurator-persistence/`, and `dist/`.
- Verify README, validation status, citation metadata, and release notes keep Python as the reference implementation.
- Verify cautious wording: no full workflow/fitting/configurator/image input/XLSX-TXT parity claim.

## Safety flags

- SAFE_TO_CLAIM_FULL_WORKFLOW_PARITY = no
- SAFE_TO_CLAIM_FULL_FITTING_PARITY = no
- SAFE_TO_CLAIM_FULL_CONFIGURATOR_PARITY = no
- SAFE_TO_CLAIM_FULL_IMAGE_INPUT_PARITY = no
- SAFE_TO_CLAIM_FULL_XLSX_TXT_PARITY = no
- SAFE_TO_CLAIM_WEBAPP_DEPOSIT_EQUIVALENT_TO_PYTHON_DEPOSIT = no

## Release actions

- Create git tag `v0.1.0-beta` only after final review.
- Prepare GitHub release notes that identify the package as a beta browser companion.
- Do not describe the webapp release as equivalent to the Python reference package.
- Enable Zenodo/archive deposition only after metadata, license, citation text, and release notes have been reviewed.
- If a DOI is assigned to the webapp beta later, update `CITATION.cff` and release notes after the DOI is known.
