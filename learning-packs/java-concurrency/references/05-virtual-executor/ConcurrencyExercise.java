package demo;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

public class ConcurrencyExercise {
    public static ExecutorService executor() {
        return Executors.newVirtualThreadPerTaskExecutor();
    }
    public static void main(String[] args) throws Exception {
        try (var pool = executor()) {
            var result = pool.submit(() -> Thread.currentThread().isVirtual());
            System.out.println("Executor wirtualny: " + result.get(10, TimeUnit.SECONDS));
        }
    }
}
