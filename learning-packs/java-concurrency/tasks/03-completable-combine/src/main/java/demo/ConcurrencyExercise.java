package demo;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

public class ConcurrencyExercise {
    public static CompletableFuture<Integer> total(CompletableFuture<Integer> first,
                                                    CompletableFuture<Integer> second) {
        return first.thenCombine(second, (left, right) -> left); // TODO: uwzględnij oba wyniki.
    }
    public static void main(String[] args) throws Exception {
        try (var pool = Executors.newFixedThreadPool(2)) {
            var first = CompletableFuture.supplyAsync(() -> 20, pool);
            var second = CompletableFuture.supplyAsync(() -> 22, pool);
            System.out.println("Suma: " + total(first, second).get(10, TimeUnit.SECONDS));
        }
    }
}
