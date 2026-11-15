package demo;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

public class ConcurrencyExercise {
    public static void complete(AtomicInteger total, CountDownLatch done, int amount) {
        total.addAndGet(amount);
        done.countDown();
    }
    public static void main(String[] args) throws Exception {
        var total = new AtomicInteger();
        var done = new CountDownLatch(2);
        try (var pool = Executors.newFixedThreadPool(2)) {
            pool.submit(() -> complete(total, done, 20));
            pool.submit(() -> complete(total, done, 22));
            System.out.println("Gotowe: " + done.await(10, TimeUnit.SECONDS) + ", suma: " + total.get());
        }
    }
}
