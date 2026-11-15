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
    private boolean exists = true;
    @GetMapping("/items/1")
    public synchronized ResponseEntity<Item> get() {
        return exists ? ResponseEntity.ok().eTag("1").body(new Item(1,"notes")) : ResponseEntity.notFound().build();
    }
    @DeleteMapping("/items/1")
    public synchronized ResponseEntity<Void> delete(@RequestHeader(value="If-Match",required=false) String match) {
        if (!exists) return ResponseEntity.notFound().build();
        exists = false;
        return ResponseEntity.noContent().build();
    }
}
