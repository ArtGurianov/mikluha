import { departure } from "./departure";
import { legalPage } from "./legalPage";
import { organizer } from "./organizer";
import { report } from "./report";
import { review } from "./review";
import { siteSettings } from "./siteSettings";
import { tour } from "./tour";

export const schemaTypes = [
  siteSettings,
  tour,
  departure,
  report,
  review,
  organizer,
  legalPage,
];
