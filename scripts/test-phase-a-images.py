"""Publication receipt negatives, not a substitute for a real registry build."""
import copy
import importlib.util
import pathlib
import unittest
from unittest import mock

ROOT=pathlib.Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('phase_a_images',ROOT/'scripts/phase-a-images.py')
images=importlib.util.module_from_spec(spec);spec.loader.exec_module(images)
SHA='a'*40;DIGEST='sha256:'+'b'*64;ORIGIN='https://mikluha-maklai.ru'


def fixture(role):
    s=images.ROLES[role];ref=images.image_name(role)+'@'+DIGEST
    inspect={'Os':'linux','Architecture':'amd64','RepoDigests':[ref],'Config':{'Cmd':s['command']}}
    identity=dict(schema=s['schema'],service=s['service'],sourceCommit=SHA)
    if role=='site':identity['legalAuthority']='commerce'
    return inspect,identity


def receipt(role):
    inspect,identity=fixture(role)
    return images.image_receipt(role,DIGEST,SHA,'staging',ORIGIN,'123','1',inspect,identity)


class ImagePublication(unittest.TestCase):
    def test_plan_is_main_only_canonical_repository_and_five_existing_targets(self):
        plan=images.plan(SHA,'staging',ORIGIN,'refs/heads/main',images.REPOSITORY)
        self.assertEqual({x['role'] for x in plan['matrix']['include']},set(images.ROLES))
        for row in plan['matrix']['include']:
            self.assertIn('AS '+row['target'],(ROOT/row['file']).read_text())
        for ref,repo in [('refs/heads/fix',images.REPOSITORY),('refs/tags/main',images.REPOSITORY),('refs/heads/main','other/mikluha')]:
            with self.assertRaises(ValueError):images.plan(SHA,'staging',ORIGIN,ref,repo)

    def test_untrusted_inputs_fail_before_docker_or_shell(self):
        for sha in ['main','a'*39,'A'*40,SHA+';echo nope']:
            with self.assertRaises(ValueError):images.inputs(sha,'staging',ORIGIN)
        for origin in ['http://example.com','https://user:pass@example.com','https://example.com/a',
                       'https://example.com?x=1','https://example.com/#bad','https://example.com\nENV=X',
                       'https://example.com:444','https://$(whoami).example.com']:
            with self.assertRaises(ValueError):images.inputs(SHA,'staging',origin)
        for digest in ['latest','sha256:'+'b'*63,'sha256:'+'B'*64,'--help']:
            with mock.patch.object(images,'docker_output') as cmd:
                with self.assertRaises(ValueError):images.inspect_published('commerce',digest,SHA,'staging',ORIGIN,'1','1')
                cmd.assert_not_called()

    def test_actual_platform_digest_and_distinct_role_command_required(self):
        for role in images.ROLES:
            inspect,identity=fixture(role)
            self.assertEqual(receipt(role)['deployment'],'NOT_RUN')
            for field,value in [('Os','windows'),('Architecture','arm64'),('RepoDigests',['other@'+DIGEST]),('Config',{'Cmd':['sh']})]:
                bad=copy.deepcopy(inspect);bad[field]=value
                with self.assertRaises(ValueError):images.image_receipt(role,DIGEST,SHA,'staging',ORIGIN,'123','1',bad,identity)

    def test_commit_service_schema_and_site_legal_authority_are_baked_requirements(self):
        for role in images.ROLES:
            inspect,identity=fixture(role)
            for field,value in [('sourceCommit','c'*40),('service','other'),('schema',None),('schema',True)]:
                bad=dict(identity);bad[field]=value
                with self.assertRaises(ValueError):images.image_receipt(role,DIGEST,SHA,'staging',ORIGIN,'123','1',inspect,bad)
        inspect,identity=fixture('site');identity.pop('legalAuthority')
        with self.assertRaises(ValueError):images.image_receipt('site',DIGEST,SHA,'staging',ORIGIN,'123','1',inspect,identity)

    def test_incomplete_duplicate_and_mixed_generation_bundles_refused(self):
        rows=[receipt(role) for role in images.ROLES]
        result=images.assemble(rows,SHA,'staging',ORIGIN,'123','1')
        self.assertEqual(len(result['images']),5);self.assertEqual(result['sales'],'CLOSED')
        for bad in [rows[:-1],rows+[rows[0]],rows[:-1]+[rows[0]]]:
            with self.assertRaises(ValueError):images.assemble(bad,SHA,'staging',ORIGIN,'123','1')
        for field,value in [('build',{'source_commit':'c'*40}),('workflow',{'run_id':'124','run_attempt':'1'}),
                            ('platform','linux/arm64'),('deployment','PASS'),('verification','NOT_RUN'),
                            ('image','ghcr.io/other/mikluha-site-ssr@'+DIGEST),('identity',{})]:
            bad=copy.deepcopy(rows);bad[0][field]=value
            with self.assertRaises(ValueError):images.assemble(bad,SHA,'staging',ORIGIN,'123','1')

    def test_stopped_container_identity_is_copied_not_executed_and_cleanup_on_failure(self):
        inspect,identity=fixture('worker');calls=[]
        def command(args):
            calls.append(args)
            if args[:2]==['image','inspect']:
                import json
                return json.dumps([inspect]).encode()
            if args[0]=='cp':raise RuntimeError('missing identity')
            return b''
        with mock.patch.object(images,'docker_output',side_effect=command):
            with self.assertRaises(RuntimeError):images.inspect_published('worker',DIGEST,SHA,'staging',ORIGIN,'123','1')
        self.assertEqual(calls[0],['pull','--platform','linux/amd64',images.image_name('worker')+'@'+DIGEST])
        create=next(c for c in calls if c[0]=='create');self.assertIn('none',create)
        self.assertEqual(calls[-1],['rm',create[create.index('--name')+1]])
        self.assertFalse(any(c[0] in ['run','start','exec'] for c in calls))


if __name__=='__main__':unittest.main()
