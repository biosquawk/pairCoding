package demo;
import java.net.URI;
import tools.jackson.core.StreamReadFeature;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.json.JsonMapper;
import java.net.http.*;
import java.util.*;
import java.util.concurrent.*;
import java.time.Duration;
import org.junit.jupiter.api.*;
import org.springframework.boot.SpringApplication;
import org.springframework.context.ConfigurableApplicationContext;
import static org.junit.jupiter.api.Assertions.*;
class ApiContractTest {
    static final JsonMapper JSON = JsonMapper.builder()
        .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
        .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS).build();
    static void assertJsonEquals(String expected, String actual) {
        assertJsonEquals(expected, actual, "JSON response differs");
    }
    static void assertJsonEquals(String expected, String actual, String message) {
        assertEquals(JSON.readTree(expected), JSON.readTree(actual), message);
    }
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
    @Test void repeatedPostOverHttp() throws Exception {
        String body = "{\"name\":\"alpha\"}";
        var first = request("POST","/items",body,"Idempotency-Key","a");assertEquals(201,first.statusCode());
        assertEquals("/items/1",first.headers().firstValue("Location").orElse(""));
        assertJsonEquals("{\"id\":1,\"name\":\"alpha\"}",first.body());
        var replay = request("POST","/items",body,"Idempotency-Key","a");assertEquals(201,replay.statusCode());
        assertJsonEquals(first.body(),replay.body(),"Same key and payload must replay the first item");
        assertEquals(first.headers().firstValue("Location"),replay.headers().firstValue("Location"));
        var conflict = request("POST","/items","{\"name\":\"other\"}","Idempotency-Key","a");assertEquals(409,conflict.statusCode());assertJsonEquals("{\"code\":\"KEY_REUSED\"}",conflict.body());
        assertJsonEquals("["+first.body()+"]",request("GET","/items",null).body());
        var futures = List.of(client.sendAsync(build("POST","/items",body,"Idempotency-Key","b"),HttpResponse.BodyHandlers.ofString()),client.sendAsync(build("POST","/items",body,"Idempotency-Key","b"),HttpResponse.BodyHandlers.ofString()));
        var b1 = futures.get(0).get(10,TimeUnit.SECONDS);var b2 = futures.get(1).get(10,TimeUnit.SECONDS);
        assertEquals(201,b1.statusCode());assertEquals(201,b2.statusCode());assertJsonEquals(b1.body(),b2.body());
        assertEquals("/items/2",b1.headers().firstValue("Location").orElse(""));
        assertEquals(b1.headers().firstValue("Location"),b2.headers().firstValue("Location"));
        assertJsonEquals("["+first.body()+","+b1.body()+"]",request("GET","/items",null).body());
        for (var bad : List.of(request("POST","/items",body),request("POST","/items","{}","Idempotency-Key","c"),request("POST","/items","not-json","Idempotency-Key","c"))) assertEquals(400,bad.statusCode());
        assertEquals("/items/3",request("POST","/items","{\"name\":\"gamma\"}","Idempotency-Key","c").headers().firstValue("Location").orElse(""));
    }
}
