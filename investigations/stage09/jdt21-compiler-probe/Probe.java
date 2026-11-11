import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.TimeUnit;

// Operator-only Java21 source-file launcher. No application code, shell, network or LSP.
// Writes bounded raw evidence to the private artifact bind; classes stay in bounded tmpfs.
class Probe {
  static final Path ART = Path.of("/artifacts"), ROOT = Path.of("/probe");
  static final String JDK = "/opt/java/openjdk", ECJ = "/opt/jdt/plugins/org.eclipse.jdt.core.compiler.batch_3.46.200.v20261008-1115.jar";
  static final int CAP = 262144;
  static volatile boolean overflow;
  static String json(Object v) {
    if(v == null) return "null";
    if(v instanceof Map<?,?> m) { var a=new ArrayList<String>(); for(var e:m.entrySet()) a.add(json(e.getKey().toString())+":"+json(e.getValue())); return "{"+String.join(",",a)+"}"; }
    if(v instanceof Iterable<?> a) { var b=new ArrayList<String>(); for(var e:a)b.add(json(e)); return "["+String.join(",",b)+"]"; }
    if(v instanceof Number || v instanceof Boolean) return v.toString();
    var b=new StringBuilder("\""); for(char c:v.toString().toCharArray()) { switch(c) { case '"': b.append("\\\""); break; case '\\': b.append("\\\\"); break; case '\n': b.append("\\n"); break; case '\r': b.append("\\r"); break; case '\t': b.append("\\t"); break; default: if(c<32)b.append(String.format("\\u%04x",(int)c)); else b.append(c); } } return b.append('"').toString();
  }
  static void save(String name,Object value) throws IOException { Files.writeString(ART.resolve(name),json(value)+"\n",StandardOpenOption.CREATE_NEW); }
  static Map<String,Object> identity(Path p) throws Exception {
    if(!Files.isRegularFile(p) || Files.size(p)>536870912L)throw new IOException("missing/oversize identity: "+p);
    var md=MessageDigest.getInstance("SHA-256"); try(var in=Files.newInputStream(p)) { byte[] b=new byte[65536]; int n; while((n=in.read(b))!=-1)md.update(b,0,n); }
    return Map.of("path",p.toString(),"size",Files.size(p),"sha256",HexFormat.of().formatHex(md.digest()));
  }
  static Thread pump(InputStream in,Path out,Process process) {
    var t=new Thread(()-> { try(in;var dest=Files.newOutputStream(out,StandardOpenOption.CREATE_NEW)) { byte[] b=new byte[8192]; int n,total=0; while((n=in.read(b))!=-1) { int take=Math.min(n,Math.max(0,CAP-total)); if(take>0)dest.write(b,0,take); total+=n; if(total>CAP) { overflow=true; process.destroyForcibly(); } } } catch(IOException e) { overflow=true; process.destroyForcibly(); } }); t.setDaemon(true);t.start();return t;
  }
  static Map<String,Object> command(String id,List<String> argv,int timeout) throws Exception {
    overflow=false; var r=new LinkedHashMap<String,Object>(); r.put("id",id);r.put("argv",argv); r.put("startedUTC",Instant.now().toString());long start=System.nanoTime();
    var pb=new ProcessBuilder(argv).directory(Path.of("/tmp").toFile());pb.environment().clear();pb.environment().putAll(Map.of("HOME","/tmp","TMPDIR","/tmp","LANG","C.UTF-8","PATH",JDK+"/bin:/usr/bin:/bin","JAVA_HOME",JDK));
    Process p;
    try { p=pb.start(); } catch(IOException e) { r.put("launchError",e.toString());r.put("exit",null);r.put("elapsedMs",(System.nanoTime()-start)/1000000);r.put("status","LAUNCH_ERROR");r.put("timedOut",false);r.put("outputOverflow",false);Files.createFile(ART.resolve(id+".stdout"));Files.createFile(ART.resolve(id+".stderr"));r.put("stdout",identity(ART.resolve(id+".stdout")));r.put("stderr",identity(ART.resolve(id+".stderr")));return r; }
    p.getOutputStream().close();
    var a=pump(p.getInputStream(),ART.resolve(id+".stdout"),p); var b=pump(p.getErrorStream(),ART.resolve(id+".stderr"),p);
    boolean timedOut=!p.waitFor(timeout,TimeUnit.SECONDS);
    if(timedOut || overflow) { p.descendants().forEach(h->h.destroyForcibly());p.destroyForcibly(); if(!p.waitFor(1,TimeUnit.SECONDS))throw new IOException("CHILD_STOP_UNCONFIRMED"); }
    a.join(500);b.join(500);if(a.isAlive()||b.isAlive())throw new IOException("STREAM_END_UNCONFIRMED");
    r.put("exit",p.exitValue());r.put("timedOut",timedOut);r.put("outputOverflow",overflow);r.put("elapsedMs",(System.nanoTime()-start)/1000000);r.put("status",timedOut?"TIMEOUT":overflow?"OUTPUT_LIMIT":"EXITED");
    r.put("stdout",identity(ART.resolve(id+".stdout")));r.put("stderr",identity(ART.resolve(id+".stderr")));return r;
  }
  static List<Object> inventory(Path dir) throws Exception {
    var entries=new ArrayList<Object>();long total=0;
    try(var paths=Files.walk(dir)) { for(var p:paths.sorted().toList()) { if(Files.isSymbolicLink(p))throw new IOException("symlink output"); if(Files.isRegularFile(p)) { if(!p.toString().endsWith(".class"))throw new IOException("unexpected output");total+=Files.size(p);if(entries.size()>=64||total>4194304)throw new IOException("class inventory limit");var e=new LinkedHashMap<>(identity(p));e.put("relative",dir.relativize(p).toString());entries.add(e); } } }
    return entries;
  }
  public static void main(String[] args) throws Exception {
    if(args.length!=0)throw new IllegalArgumentException("no arguments");
    var report=new LinkedHashMap<String,Object>();report.put("scope","COMPILER_ONLY_DIAGNOSTIC_NOT_PRODUCT_OR_FULL_PASS"); report.put("classOrigin",Map.of("status","NOT_READ","reason","lib/modules and ct.sym identities only; selected ScopedValue class/signature origin not instrumented"));
    report.put("supervisorJVM",Map.of("version",System.getProperty("java.version"),"home",System.getProperty("java.home")));report.put("previewEnabled",false);
    try {
      var ids=new ArrayList<Object>();for(String p:List.of(JDK+"/bin/java",JDK+"/bin/javac",JDK+"/lib/modules",JDK+"/lib/ct.sym",JDK+"/release",ECJ))ids.add(identity(Path.of(p)));report.put("identities",ids);
      var sources=new ArrayList<Object>();for(String p:List.of("sources/preview/Demo.java","sources/valid/Valid.java","sources/type-error/TypeError.java"))sources.add(identity(ROOT.resolve(p)));report.put("sources",sources);
      if(!((Map<?,?>)ids.get(5)).get("sha256").equals("f667bb3666d9875a2309fa2447a19e6cdd960281473bd7125a22c5a435246d21"))throw new IOException("compiler pin mismatch");
      if(!((Map<?,?>)sources.get(0)).get("sha256").equals("d9a01bba6dd72195bddce0aa57afe4eba51d761d8eacf7097bfa121d674704c8"))throw new IOException("primary bytes mismatch");
      var meta=new ArrayList<Object>();meta.add(command("java-version",List.of(JDK+"/bin/java","-version"),8));meta.add(command("javac-version",List.of(JDK+"/bin/javac","-version"),8));meta.add(command("ecj-version",List.of(JDK+"/bin/java","-jar",ECJ,"-version"),8));report.put("versions",meta);
      for(Object v:meta)if(!Objects.equals(((Map<?,?>)v).get("exit"),0)||!((Map<?,?>)v).get("status").equals("EXITED"))throw new IOException("VERSION_LAUNCH_FAILED");
      if(!System.getProperty("java.version").startsWith("21."))throw new IOException("not target JVM21");
      var commands=new ArrayList<Object>();report.put("commands",commands);
      for(String example:List.of("preview","valid","type-error"))for(String compiler:List.of("javac","ecj")) {
        String id=example+"-"+compiler,file=example.equals("preview")?"Demo.java":example.equals("valid")?"Valid.java":"TypeError.java";
        Path out=Path.of("/tmp/classes-"+id);Files.createDirectory(out); // always NEW; no stale outputs
        var argv=new ArrayList<String>();argv.add(JDK+"/bin/"+(compiler.equals("javac")?"javac":"java"));
        if(compiler.equals("ecj"))argv.addAll(List.of("-jar",ECJ));
        argv.addAll(List.of("--release","21","-proc:none","-encoding","UTF-8","-d",out.toString()));
        if(compiler.equals("ecj"))argv.addAll(List.of("-log",ART.resolve(id+".xml").toString()));
        argv.add(ROOT.resolve("sources/"+example+"/"+file).toString());
        var r=command(id,argv,26);r.put("classes",inventory(out));
        if(Files.exists(ART.resolve(id+".xml"))) { if(Files.size(ART.resolve(id+".xml"))>CAP)throw new IOException("xml output limit"); r.put("xml",identity(ART.resolve(id+".xml"))); }
        commands.add(r); save(id+".json",r);
        if(!r.get("status").equals("EXITED"))throw new IOException("invocation not completed; remaining NOT_RUN");
      }
      report.put("status","EVIDENCE_COMPLETE_NO_PASS_CLAIM");
    } catch(Exception e) { report.put("status","HARNESS_OR_LAUNCH_FAILURE");report.put("failure",e.toString());save("probe.json",report);throw e; }
    save("probe.json",report);
  }
}
