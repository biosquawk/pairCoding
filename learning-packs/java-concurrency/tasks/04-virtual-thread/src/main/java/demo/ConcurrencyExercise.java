package demo;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

public class ConcurrencyExercise {
    public static Thread start(Runnable work) {
        return Thread.ofPlatform().name("lesson-worker").start(work); // TODO: wybierz wątek wirtualny.
    }
    public static void main(String[] args) throws Exception {
        var virtual = new CompletableFuture<Boolean>();
        start(() -> virtual.complete(Thread.currentThread().isVirtual()));
        System.out.println("Wirtualny: " + virtual.get(10, TimeUnit.SECONDS));
    }
}
