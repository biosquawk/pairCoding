"""Static evidence integrity/bytecode checks, NOT ECJ/JDT/javac runtime tests."""
import hashlib, importlib.util, json, pathlib, re, unittest
ROOT = pathlib.Path(__file__).parent
spec=importlib.util.spec_from_file_location('inspect_bytecode',ROOT/'inspect-bytecode.py')
inspection=importlib.util.module_from_spec(spec);spec.loader.exec_module(inspection)
class StaticEvidence(unittest.TestCase):
    def test_pinned_source_hashes(self):
        entries=json.loads((ROOT/'sources.json').read_text())
        self.assertGreater(len(entries),20)
        for e in entries:
            with self.subTest(file=e.get('local')):
                self.assertEqual(e['status'],'OK')
                self.assertRegex(e['revision'],r'^[a-f0-9]{40}$')
                self.assertEqual(hashlib.sha256((ROOT/e['local']).read_bytes()).hexdigest(),e['sha256'])
    def test_archive_and_bytecode_reproduce(self):
        pin=json.loads((ROOT/'artifacts.json').read_text())
        actual=inspection.inspect(pin['archive'])
        self.assertEqual(actual,json.loads((ROOT/'bytecode.json').read_text()))
    def test_actual_bytecode_older_compliance_selects_used_id(self):
        evidence=json.loads((ROOT/'bytecode.json').read_text())
        method,latest=evidence['methods']
        ops={i['offset']:i for i in method['instructions']}
        self.assertEqual(ops[381]['constant'][1][0],'complianceLevel')
        self.assertEqual(ops[384]['constant'][1][0],'getLatestJDKLevel')
        self.assertEqual((ops[387]['op'],ops[388]['op'],ops[388]['target']),('lcmp','ifge',399))
        self.assertEqual(ops[391]['constant'],0x400000+1108)
        self.assertEqual(ops[399]['constant'],0x400000+1111)
        self.assertEqual(latest['instructions'][0]['constant'],71<<16)
        self.assertLess((21+44)<<16,latest['instructions'][0]['constant'])
    def test_source_and_wire_used_problem_id_agree(self):
        source=(ROOT/'raw/jdt-ProblemReporter.java').read_text()
        self.assertIn('this.options.complianceLevel < ClassFileConstants.getLatestJDKLevel()',source)
        self.assertIn('severity = computeSeverity(IProblem.PreviewAPIUsed);',source)
        observed=json.loads((ROOT/'observations.json').read_text())
        for event in observed['java21']['diagnosticVersionFields']:
            for d in event['diagnostics']:
                self.assertEqual((d['code'],d['severity']),('4195412',2))
    def test_frozen_oracle_has_independent_message_constraint(self):
        observed=json.loads((ROOT/'observations.json').read_text())
        self.assertIn('/ScopedValue/.test(d.message)&&d.severity===1',observed['oracleLine165'])
        for event in observed['java21']['diagnosticVersionFields']:
            for d in event['diagnostics']:
                self.assertIsNone(re.search('ScopedValue',d['message']))
        # Source-based predicted disabled message would still miss that literal.
        disabled="This API is part of the preview feature 'Scoped Values' which is disabled by default. Use --enable-preview to enable"
        self.assertIsNone(re.search('ScopedValue',disabled))
    def test_javac_policy_source_has_nonreflective_disabled_error(self):
        check=(ROOT/'raw/javac21-Check.java').read_text()
        self.assertIn('if ((s.flags() & PREVIEW_REFLECTIVE) == 0)',check)
        self.assertIn('log.error(pos, Errors.IsPreview(s));',check)
        annotation=(ROOT/'raw/javac21-PreviewFeature.java').read_text()
        self.assertIn('public boolean reflective() default false;',annotation)
        scoped=(ROOT/'raw/javac21-ScopedValue.java').read_text()
        self.assertIn('@PreviewFeature(feature = PreviewFeature.Feature.SCOPED_VALUES)',scoped)
if __name__=='__main__':unittest.main()
