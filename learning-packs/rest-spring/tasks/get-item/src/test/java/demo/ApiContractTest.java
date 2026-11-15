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
    @Test void getReturnsRepresentationOverHttp() throws Exception {
        var r = request("GET", "/items/1", null, null);
        assertEquals(200, r.statusCode(), "GET must return 200");
        assertTrue(r.headers().firstValue("Content-Type").orElse("").contains("application/json"));
        assertTrue(r.body().contains("\"id\":1")); assertTrue(r.body().contains("\"name\":\"notes\""));
        assertEquals(200, request("GET", "/items/1", null, null).statusCode());
    }
}
