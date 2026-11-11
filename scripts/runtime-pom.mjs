import { XMLParser, XMLValidator } from 'fast-xml-parser';
/** Input MUST be Maven help:effective-pom output, never a guessed source pom. */
export function inspectEffectivePom(xml, release, preview) {
  if (typeof xml !== 'string' || Buffer.byteLength(xml) > 4*1024*1024 || /<!\s*(DOCTYPE|ENTITY)/i.test(xml) || XMLValidator.validate(xml) !== true) throw new Error('Invalid/unsafe effective POM');
  const p = new XMLParser({ ignoreAttributes: false, parseTagValue: false, processEntities: false }).parse(xml).project;
  if (!p || p.modules) throw new Error('Select one Maven module; aggregate reactors require explicit module task.');
  const list = v => v === undefined ? [] : Array.isArray(v) ? v : [v];
  const plugins = list(p.build?.plugins?.plugin);
  const compiler = plugins.filter(v => v.artifactId === 'maven-compiler-plugin');
  if (compiler.length !== 1 || !/^\d+\.\d+\.\d+$/.test(compiler[0].version ?? '')) throw new Error('Compiler plugin must be explicitly pinned in effective POM');
  if(plugins.some(v=>v.artifactId==='maven-toolchains-plugin')) throw new Error('Alternate Maven toolchain prohibited');
  const properties = p.properties ?? {};
  if(properties['maven.compiler.executable'] || properties['maven.compiler.fork']==='true' || properties['maven.compiler.compilerId'] && properties['maven.compiler.compilerId']!=='javac') throw new Error('Alternate compiler properties prohibited');
  const configurations = [compiler[0].configuration ?? {}, ...list(compiler[0].executions?.execution).map(e => e.configuration ?? {})];
  const releases = [properties['maven.compiler.release'], properties['maven.compiler.testRelease'], ...configurations.flatMap(c => [c.release, c.testRelease])].filter(v => v !== undefined);
  if (!releases.length || releases.some(v => String(v) !== String(release))) throw new Error('TARGET_PROFILE_CONFLICT: effective release differs or is absent');
  for (const value of [properties['maven.compiler.source'], properties['maven.compiler.target'], properties['maven.compiler.testSource'], properties['maven.compiler.testTarget'], ...configurations.flatMap(c => [c.source,c.target,c.testSource,c.testTarget])].filter(v => v !== undefined)) if (String(value) !== String(release)) throw new Error('TARGET_PROFILE_CONFLICT: source/target differs');
  for (const c of configurations) {
    if (c.fork === 'true' || c.executable || c.jdkToolchain || c.compilerId && c.compilerId !== 'javac') throw new Error('Alternate compiler/toolchain prohibited');
    const args = list(c.compilerArgs?.arg).concat(c.compilerArgument ? [c.compilerArgument] : []);
    if (args.length) throw new Error('Extra compiler flags require reviewed adapter support (no hidden release/preview overrides).');
    if (c.enablePreview !== undefined && String(c.enablePreview) !== String(preview)) throw new Error('TARGET_PROFILE_CONFLICT: preview differs');
  }
  const enabled = properties['maven.compiler.enablePreview'] ?? compiler[0].configuration?.enablePreview ?? 'false';
  if (String(enabled) !== String(preview)) throw new Error('TARGET_PROFILE_CONFLICT: preview differs');
  const surefire = plugins.find(v => v.artifactId === 'maven-surefire-plugin');
  if (!surefire || !/^\d+\.\d+\.\d+$/.test(surefire.version ?? '')) throw new Error('Surefire must be pinned');
  if (surefire.configuration?.reportsDirectory && surefire.configuration.reportsDirectory !== '/artifacts/junit') throw new Error('Custom report directory unsupported');
  if (surefire.configuration?.argLine && !/^(?:--enable-preview)?$/.test(surefire.configuration.argLine)) throw new Error('Unreviewed test VM arguments');
  const spring = plugins.find(v => v.artifactId === 'spring-boot-maven-plugin');
  return { release, preview, compilerVersion: compiler[0].version, springVersion: spring?.version ?? null };
}
