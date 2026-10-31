"""The installed Coolify4.5.3 raw parser appends sequence labels to every service."""
import json
from pathlib import Path
import sys
import unittest

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'config/mikluha-phase-a/lib'))
import maa_plan as plan


def raw_parser_labels(labels,uuid):
    # Mirror the observed Laravel Collection::contains(value)/push(value)
    # operations. A mapping becomes mixed-keyed; a sequence remains a sequence.
    result=labels.copy()
    for check,value in [('coolify.managed','coolify.managed=true'),
                        ('coolify.applicationUuid='+uuid,'coolify.applicationUuid='+uuid),
                        ('coolify.type','coolify.type=application')]:
        values=result.values() if isinstance(result,dict) else result
        if check not in values:
            if isinstance(result,list):result.append(value)
            else:result[next((n for n in range(len(result)+1) if n not in result))]=value
    return result


class CoolifyLabels(unittest.TestCase):
    def test_prior_mapping_reproduces_the_observed_non_string_key_failure(self):
        labels=raw_parser_labels({'traefik.enable':'false','coolify.managed':'true'},'a'*24)
        self.assertTrue(any(type(key) is int for key in labels))

    def test_all_services_survive_raw_parser_with_same_application_routing_labels(self):
        c=json.loads((ROOT/'config/mikluha-phase-a/candidate.json').read_text())
        for candidate in [c,plan.working(c)]:
            for service in plan.compose(candidate)['services'].values():
                labels=service['labels']
                self.assertIsInstance(labels,list)
                original=dict(value.split('=',1) for value in labels)
                processed=raw_parser_labels(labels,'a'*24)
                self.assertIsInstance(processed,list)
                rendered=dict(value.split('=',1) for value in processed)
                for key,value in original.items():self.assertEqual(rendered[key],value)
                self.assertEqual(rendered['traefik.enable'],'false')
                self.assertEqual(rendered['coolify.applicationUuid'],'a'*24)
                self.assertEqual(rendered['coolify.type'],'application')


if __name__=='__main__':unittest.main()
