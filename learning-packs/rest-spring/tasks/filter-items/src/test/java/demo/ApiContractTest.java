package demo;
import java.net.URI;
import java.net.http.*;
import java.util.*;
import java.util.concurrent.*;
import java.time.Duration;
import org.junit.jupiter.api.*;
import org.springframework.boot.SpringApplication;
import org.springframework.context.ConfigurableApplicationContext;
import static org.junit.jupiter.api.Assertions.*;
class ApiContractTest {
    ConfigurableApplicationContext app;
    HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
    String base;
    @BeforeEach void start() {
        app = new SpringApplication(ApiApplication.class).run("--server.port=0", "--spring.main.banner-mode=off");
        base = "http://127.0.0.1:" + app.getEnvironment().getProperty("local.server.port");
    }
    @AfterEach void stop() { if (app != null) app.close(); }
    HttpRequest build(String method, String route, String body, String... headers) {
        var b = HttpRequest.newBuilder(URI.create(base + route)).timeout(Duration.ofSeconds(10)).header("Content-Type","application/json");
        for (int i=0; i<headers.length; i+=2) b.header(headers[i],headers[i+1]);
        return b.method(method, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(body)).build();
    }
    HttpResponse<String> request(String method, String route, String body, String... headers) throws Exception {
        return client.send(build(method,route,body,headers), HttpResponse.BodyHandlers.ofString());
    }
    @Test void filteredCollectionOverHttp() throws Exception {
        var all = request("GET","/items",null);assertEquals(200,all.statusCode());
        assertTrue(all.headers().firstValue("Content-Type").orElse("").contains("application/json"));
        assertEquals("[{\"id\":1,\"name\":\"notes\"},{\"id\":2,\"name\":\"tasks\"}]",all.body());
        assertEquals("[{\"id\":1,\"name\":\"notes\"}]",request("GET","/items?q=NOTE",null).body(),"Filter must be applied case-insensitively");
        assertEquals("[{\"id\":2,\"name\":\"tasks\"}]",request("GET","/items?q=ask",null).body());
        var empty = request("GET","/items?q=absent",null);assertEquals(200,empty.statusCode());assertEquals("[]",empty.body());
        assertEquals(all.body(),request("GET","/items?q=",null).body());
        assertEquals(all.body(),request("GET","/items",null).body(),"Filtering must not remove stored items");
    }
}
