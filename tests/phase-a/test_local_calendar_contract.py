"""Full-source consistency; SSR's minimal Docker context intentionally omits Admin components."""
import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]


class SharedLocalCalendar(unittest.TestCase):
    def test_sql_ssr_and_admin_share_one_calendar_contract(self):
        module = (ROOT / 'control-room/lib/local-calendar.ts').read_text()
        zone = re.search(r"LOCAL_TIME_ZONE = '([^']+)'", module).group(1)
        sql = (ROOT / 'commerce/migrations/0020_krasnoyarsk_local_calendar.sql').read_text()
        self.assertIn("p_at AT TIME ZONE '" + zone + "'", sql)
        self.assertIn("LANGUAGE sql STABLE STRICT", sql)
        self.assertIn("LEGAL_CALENDAR_HISTORY_REQUIRES_REVIEW", sql)
        self.assertNotIn("calendar_timezone", sql)
        admin = (ROOT / 'control-room/components/editorial-workspace.tsx').read_text()
        ssr = (ROOT / 'lib/cms/legal-projection.ts').read_text()
        self.assertIn("import { localCalendarDate } from '@/lib/local-calendar'", admin)
        self.assertIn('min={localCalendarDate()}', admin)
        self.assertIn('import { localCalendarDate } from "../../control-room/lib/local-calendar"', ssr)
        self.assertIn('const today = localCalendarDate(now)', ssr)
        self.assertNotRegex(admin + ssr, r'timeZone\s*:')
