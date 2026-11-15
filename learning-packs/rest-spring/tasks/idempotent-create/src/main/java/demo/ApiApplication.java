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
    record Input(String name) {}
    record Item(long id, String name) {}
    record Problem(String code) {}
    private final Map<String,Item> results = new HashMap<>();
    private final List<Item> items = new ArrayList<>();
    @GetMapping("/items")
    public synchronized List<Item> list() { return List.copyOf(items); }
    @PostMapping("/items")
    public synchronized ResponseEntity<?> create(@RequestHeader(value="Idempotency-Key",required=false) String key, @RequestBody Input input) {
        if (key == null || key.isBlank() || input == null || input.name() == null || input.name().isBlank()) return ResponseEntity.badRequest().body(new Problem("INVALID_REQUEST"));
        var item = new Item(items.size()+1,input.name());items.add(item);results.put(key,item);
        return ResponseEntity.created(java.net.URI.create("/items/"+item.id())).body(item);
    }
}
