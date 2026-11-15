package demo;

import org.junit.jupiter.api.Test;
import java.util.concurrent.*;
import static org.junit.jupiter.api.Assertions.*;
import java.util.concurrent.atomic.AtomicInteger;

class ConcurrencyExerciseTest {
    @Test void twoRealWorkersReleaseWaitingCaller() throws Exception {
        var total = new AtomicInteger();
        var done = new CountDownLatch(2);
        long caller = Thread.currentThread().threadId();
        try (var pool = Executors.newFixedThreadPool(2)) {
            Future<?> first = pool.submit(() -> {
                assertNotEquals(caller, Thread.currentThread().threadId());
                ConcurrencyExercise.complete(total, done, 20);
            });
            Future<?> second = pool.submit(() -> {
                assertNotEquals(caller, Thread.currentThread().threadId());
                ConcurrencyExercise.complete(total, done, 22);
            });
            boolean finished = done.await(10, TimeUnit.SECONDS);
            first.get(10, TimeUnit.SECONDS);
            second.get(10, TimeUnit.SECONDS);
            assertTrue(finished, "Każdy worker musi zmniejszyć latch");
            assertEquals(0, done.getCount());
            assertEquals(42, total.get());
        }
    }
    @Test void zeroAmountStillCompletesOneJob() throws Exception {
        var total = new AtomicInteger(9);
        var done = new CountDownLatch(1);
        try (var pool = Executors.newSingleThreadExecutor()) {
            var future = pool.submit(() -> ConcurrencyExercise.complete(total, done, 0));
            boolean finished = done.await(10, TimeUnit.SECONDS);
            future.get(10, TimeUnit.SECONDS);
            assertTrue(finished, "Także praca z kwotą zero ma się zakończyć");
            assertEquals(9, total.get());
        }
    }
}
