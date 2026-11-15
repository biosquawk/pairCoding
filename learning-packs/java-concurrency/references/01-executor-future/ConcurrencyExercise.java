package demo;

import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

public class ConcurrencyExercise {
    public static int calculate(ExecutorService pool, Callable<Integer> work) throws Exception {
        Future<Integer> result = pool.submit(work);
        return result.get();
    }

    public static void main(String[] args) throws Exception {
        try (ExecutorService pool = Executors.newSingleThreadExecutor()) {
            System.out.println("Wynik: " + calculate(pool, () -> 21 * 2));
        }
    }
}
