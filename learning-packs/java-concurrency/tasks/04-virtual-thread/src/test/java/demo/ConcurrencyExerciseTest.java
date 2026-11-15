package demo;

import org.junit.jupiter.api.Test;
import java.util.concurrent.*;
import static org.junit.jupiter.api.Assertions.*;

class ConcurrencyExerciseTest {
    @Test void workReallyRunsOnAVirtualThread() throws Exception {
        var observed = new CompletableFuture<Thread>();
        Thread returned = ConcurrencyExercise.start(() -> observed.complete(Thread.currentThread()));
        Thread actual = observed.get(10, TimeUnit.SECONDS);
        returned.join(10000);
        assertFalse(returned.isAlive(), "Wątek ma zakończyć powierzoną pracę");
        assertSame(returned, actual, "Oddaj uchwyt faktycznego workera");
        assertNotSame(Thread.currentThread(), actual, "Nie wykonuj inline");
        assertTrue(actual.isVirtual(), "To ma być rzeczywisty Loom, nie nazwa wątku");
    }
    @Test void executesSuppliedActionExactlyOnce() throws Exception {
        var count = new java.util.concurrent.atomic.AtomicInteger();
        var completed = new CompletableFuture<Boolean>();
        Thread worker = ConcurrencyExercise.start(() -> {
            count.incrementAndGet();
            completed.complete(Thread.currentThread().isVirtual());
        });
        assertTrue(completed.get(10, TimeUnit.SECONDS));
        worker.join(10000);
        assertFalse(worker.isAlive());
        assertEquals(1, count.get());
    }
}
