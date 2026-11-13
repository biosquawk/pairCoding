package demo;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class PuzzlerTest {
    @Test void predictionMatchesJavaSemantics() {
        assertEquals("cafebabe", Puzzler.prediction(), "Uzupełnij prediction po przeanalizowaniu typów i operatorów.");
    }
    @Test void demonstratorRemainsTheOriginalPuzzle() {
        assertEquals("cafebabe", Puzzler.observed(), "Nie zmieniaj demonstratora ani testu; wyjaśnij jego wynik.");
    }
}
