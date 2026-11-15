package demo;
import java.util.*;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
@SpringBootApplication
@RestController
public class ApiApplication {
    public static void main(String[] args) { SpringApplication.run(ApiApplication.class, args); }
    record Item(long id, String name) {}
    record Input(String name) {}
    record Problem(String code) {}
    private String name = "notes";
    @GetMapping("/items/1")
    public synchronized Item get() { return new Item(1,name); }
    @PutMapping("/items/1/name")
    public synchronized ResponseEntity<?> rename(@RequestBody Input input) {
        if (input == null || input.name() == null || input.name().isBlank()) return ResponseEntity.badRequest().body(new Problem("INVALID_NAME"));
        name = input.name();
        return ResponseEntity.ok(new Item(1,name));
    }
}
