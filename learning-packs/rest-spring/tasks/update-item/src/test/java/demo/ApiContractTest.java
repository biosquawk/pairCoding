package demo;
import java.net.URI;
import java.net.http.*;
import org.junit.jupiter.api.*;
import org.springframework.boot.SpringApplication;
import org.springframework.context.ConfigurableApplicationContext;
import static org.junit.jupiter.api.Assertions.*;
class ApiContractTest {
    ConfigurableApplicationContext app;
    HttpClient client = HttpClient.newHttpClient();
    String base;
    @BeforeEach void start() {
        app = new SpringApplication(ApiApplication.class).run("--server.port=0", "--spring.main.banner-mode=off");
        base = "http://127.0.0.1:" + app.getEnvironment().getProperty("local.server.port");
    }
    @AfterEach void stop() { if (app != null) app.close(); }
    HttpResponse<String> request(String method, String route, String body, String match) throws Exception {
        var b = HttpRequest.newBuilder(URI.create(base + route)).header("Content-Type","application/json");
        if (match != null) b.header("If-Match", match);
        return client.send(b.method(method, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(body)).build(), HttpResponse.BodyHandlers.ofString());
    }
    @Test void conditionalUpdateOverHttp() throws Exception {
        var first = request("GET", "/items/1", null, null);
        var tag = first.headers().firstValue("ETag").orElseThrow();
        assertEquals(428, request("PUT", "/items/1", "{\"name\":\"missing\"}", null).statusCode());
        var success = request("PUT", "/items/1", "{\"name\":\"changed\"}", tag);
        assertEquals(200, success.statusCode());
        assertNotEquals(tag, success.headers().firstValue("ETag").orElseThrow());
        assertEquals(412, request("PUT", "/items/1", "{\"name\":\"stale\"}", tag).statusCode(), "Stale ETag must be rejected");
        assertTrue(request("GET", "/items/1", null, null).body().contains("changed"));
        assertFalse(request("GET", "/items/1", null, null).body().contains("stale"));
    }
}
