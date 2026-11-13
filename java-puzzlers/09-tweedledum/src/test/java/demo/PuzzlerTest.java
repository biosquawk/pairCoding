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
        assertFalse(Puzzler.declarations().contains("TODO"), "Najpierw podaj deklaracje.");
        assertTrue(compiles("", "Declarations"), "Same deklaracje muszą być poprawne.");
    }
    @Test void firstAssignmentCompiles() throws Exception {
        assertTrue(compiles("x += i;", "LegalCase"), "Pierwsze przypisanie musi się kompilować.");
    }
    @Test void secondAssignmentFailsCompilation() throws Exception {
        assertFalse(compiles("x = x + i;", "IllegalCase"), "Drugie przypisanie musi być błędem kompilacji.");
    }
}
