package demo;

import org.junit.jupiter.api.Test;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicLong;
import static org.junit.jupiter.api.Assertions.*;

class ConcurrencyExerciseTest {
    @Test void receivesCallableResultFromAnotherThread() throws Exception {
        long caller = Thread.currentThread().threadId();
        AtomicLong worker = new AtomicLong(caller);
        CountDownLatch completed = new CountDownLatch(1);
        int result;
        try (var pool = Executors.newSingleThreadExecutor()) {
            result = ConcurrencyExercise.calculate(pool, () -> {
                worker.set(Thread.currentThread().threadId());
                completed.countDown();
                return 42;
            });
            assertTrue(completed.await(2, TimeUnit.SECONDS), "Callable musi zostać wykonany");
        }
        assertNotEquals(caller, worker.get(), "Obliczenie musi wykonać inny wątek");
        assertEquals(42, result, "Odbierz wartość przez Future.get()");
    }
    @Test void doesNotHardcodeTheExampleValue() throws Exception {
        try (var pool = Executors.newSingleThreadExecutor()) {
            assertEquals(-7, ConcurrencyExercise.calculate(pool, () -> -7));
        }
    }
}
