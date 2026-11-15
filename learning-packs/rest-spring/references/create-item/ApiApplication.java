package demo;
import java.util.*;
import java.util.concurrent.atomic.AtomicLong;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
@SpringBootApplication
@RestController
public class ApiApplication {
    record Item(long id, String name) {}
    record Input(String name) {}
    private String name = "notes";
    private long version = 1;
    public static void main(String[] args) { SpringApplication.run(ApiApplication.class, args); }
    @PostMapping("/items")
    public ResponseEntity<Item> create(@RequestBody Input input) {
        return ResponseEntity.created(java.net.URI.create("/items/1")).body(new Item(1, input.name()));
    }
}
