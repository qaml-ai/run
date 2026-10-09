### Admin site

- `GET /api/activity-trend` on the admin site, for its chart: sign-ups and returning active accounts by UTC day over
  the `days` days (14 by default, 90 at most) that end on `end_date` (today by default). A returning active account
  is one made before that day whose agents got at least one model response on it (`usage`); the days are UTC because
  that is how usage is kept. `incomplete_date` names the day still going.
- `POST /api/report` also takes `kind: "pages"` (dates only), for the journey store's report on the operator's
  website pages about the runtime.
