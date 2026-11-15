package demo;

import org.junit.jupiter.api.Test;
import java.util.concurrent.*;
import static org.junit.jupiter.api.Assertions.*;
import java.util.ArrayList;
import java.util.HashSet;

class ConcurrencyExerciseTest {
    @Test void everyTaskReallyGetsItsOwnVirtualThread() throws Exception {
        long caller = Thread.currentThread().threadId();
        try (var pool = ConcurrencyExercise.executor()) {
            var futures = new ArrayList<Future<Thread>>();
            for (int i = 0; i < 4; i++) futures.add(pool.submit(Thread::currentThread));
            var ids = new HashSet<Long>();
            for (var future : futures) {
                Thread worker = future.get(10, TimeUnit.SECONDS);
                assertNotEquals(caller, worker.threadId());
                assertTrue(worker.isVirtual(), "Każde zadanie ma działać na Loom");
                ids.add(worker.threadId());
            }
            assertEquals(4, ids.size(), "Osobny wątek dla każdego zadania, nie stała pula");
        }
    }
    @Test void stillSupportsCallableAndShutdown() throws Exception {
        var pool = ConcurrencyExercise.executor();
        try (pool) {
            record Observation(boolean virtual, int value) {}
            var value = pool.submit(() -> new Observation(Thread.currentThread().isVirtual(), -7));
            var observed = value.get(10, TimeUnit.SECONDS);
            assertTrue(observed.virtual(), "Rzeczywisty rodzaj wątku sprawdzamy po odebraniu wyniku");
            assertEquals(-7, observed.value());
        }
        assertTrue(pool.isShutdown());
        assertThrows(RejectedExecutionException.class, () -> pool.submit(() -> 1));
    }
}
