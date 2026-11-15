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
    @Test void conditionalDeletionOverHttp() throws Exception {
        var first = request("GET","/items/1",null);assertEquals(200,first.statusCode());
        String tag = first.headers().firstValue("ETag").orElseThrow();assertEquals("\"1\"",tag);
        assertEquals(428,request("DELETE","/items/1",null).statusCode(),"DELETE must require the precondition before changing state");
        assertJsonEquals(first.body(),request("GET","/items/1",null).body());
        assertEquals(412,request("DELETE","/items/1",null,"If-Match","\"stale\"").statusCode());
        var unchanged = request("GET","/items/1",null);assertJsonEquals(first.body(),unchanged.body());assertEquals(tag,unchanged.headers().firstValue("ETag").orElseThrow());
        var futures = List.of(client.sendAsync(build("DELETE","/items/1",null,"If-Match",tag),HttpResponse.BodyHandlers.ofString()),client.sendAsync(build("DELETE","/items/1",null,"If-Match",tag),HttpResponse.BodyHandlers.ofString()));
        var a = futures.get(0).get(10,TimeUnit.SECONDS);var b = futures.get(1).get(10,TimeUnit.SECONDS);
        var statuses = new ArrayList<>(List.of(a.statusCode(),b.statusCode()));Collections.sort(statuses);assertEquals(List.of(204,404),statuses,"Only one concurrent conditional delete can win");
        assertEquals("",a.statusCode()==204?a.body():b.body());
        assertEquals(404,request("GET","/items/1",null).statusCode());
        assertEquals(404,request("DELETE","/items/1",null,"If-Match",tag).statusCode());
    }
}
