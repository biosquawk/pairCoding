package demo;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import javax.tools.*;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import static org.junit.jupiter.api.Assertions.*;

class PuzzlerTest {
    @TempDir Path tmp;
    private boolean compiles(String statement, String className) throws Exception {
        JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
        assertNotNull(compiler, "Test wymaga JDK w kontenerze, nie samego JRE.");
        Path source = tmp.resolve(className + ".java");
        Files.writeString(source, "class " + className + " { void check() { " + Puzzler.declarations() + statement + " } }");
        DiagnosticCollector<JavaFileObject> diagnostics = new DiagnosticCollector<>();
        try (StandardJavaFileManager files = compiler.getStandardFileManager(diagnostics, null, null)) {
            return compiler.getTask(null, files, diagnostics, List.of("-proc:none", "-d", tmp.toString()), null,
                files.getJavaFileObjects(source)).call();
        }
    }
    @Test void declarationsCompileIndependently() throws Exception {
        assertTrue(compiles("", "Declarations"));
    }
    @Test void simplePredictionMatchesRealCompiler() throws Exception {
        assertEquals("COMPILES", Puzzler.simplePrediction());
        assertTrue(compiles("x = x + i;", "SimpleCase"));
    }
    @Test void compoundPredictionMatchesRealCompiler() throws Exception {
        assertEquals("COMPILES", Puzzler.compoundPrediction());
        assertTrue(compiles("x += i;", "CompoundCase"));
    }
}
