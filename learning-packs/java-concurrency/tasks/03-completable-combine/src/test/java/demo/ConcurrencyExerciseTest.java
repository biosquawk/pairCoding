package demo;

import org.junit.jupiter.api.Test;
import java.util.concurrent.*;
import static org.junit.jupiter.api.Assertions.*;

class ConcurrencyExerciseTest {
    @Test void combinesResultsOfRealWorkerTasks() throws Exception {
        long caller = Thread.currentThread().threadId();
        try (var pool = Executors.newFixedThreadPool(2)) {
            var first = CompletableFuture.supplyAsync(() -> {
                assertNotEquals(caller, Thread.currentThread().threadId());
                return 20;
            }, pool);
            var second = CompletableFuture.supplyAsync(() -> {
                assertNotEquals(caller, Thread.currentThread().threadId());
                return 22;
            }, pool);
            assertEquals(42, ConcurrencyExercise.total(first, second).get(10, TimeUnit.SECONDS));
        }
    }
    @Test void waitsForBothInputsAndDoesNotHardcodeMain() throws Exception {
        var first = CompletableFuture.completedFuture(-8);
        var second = new CompletableFuture<Integer>();
        var combined = ConcurrencyExercise.total(first, second);
        assertFalse(combined.isDone(), "Nie ma jeszcze drugiego wyniku");
        second.complete(3);
        assertEquals(-5, combined.get(10, TimeUnit.SECONDS));
    }
}
