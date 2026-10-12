# Independent semantic acceptance inputs

24 public synthetic examples: 8 complete, 8 insufficient, 8 contradictory. These are expected labels, not model results. Files are frozen by SHA-256 in ../review-manifest.json before any real model call; no cases are removed for an unfavorable result. The 12 development cases live separately in ../dev/review-cases.json.

The evaluation runner must send only each case.state to JEV. IDs, expected outcomes, rationale and split names are never model input. Use development inputs to decide confidence rules; freeze the rule before running holdout. If a case/label must be corrected, retain the original manifest and results and record a versioned decision; do not silently retune on holdout.

This first split focuses on current-report commercial permission, code/report distinction, unrelated-product statements and prompt injection. Service and current-quote linkage are held valid by the explicit service statement so uncertain terms remain distinguishable from a wrong source. It does not claim exhaustive service/provenance coverage; adversarial local tests and future separately versioned evaluation are needed for broader conclusions. No real JEV outcomes or calibration exist yet.
