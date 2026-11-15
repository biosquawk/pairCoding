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
    @GetMapping("/items/1")
    public ResponseEntity<Item> get() { return ResponseEntity.ok(new Item(1, "notes")); }
}
