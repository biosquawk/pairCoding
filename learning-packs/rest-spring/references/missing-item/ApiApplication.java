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
    record Problem(String code, long id) {}
    @GetMapping("/items/{id}")
    public ResponseEntity<?> get(@PathVariable("id") long id) {
        if (id == 1) return ResponseEntity.ok(new Item(1,"notes"));
        return ResponseEntity.status(404).body(new Problem("ITEM_NOT_FOUND",id));
    }
}
