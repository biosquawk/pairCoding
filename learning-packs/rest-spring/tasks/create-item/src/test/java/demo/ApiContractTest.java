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
    @Test void creationContractOverHttp() throws Exception {
        var r = request("POST", "/items", "{\"name\":\"alpha\"}", null);
        assertEquals(201, r.statusCode(), "POST creation must return 201");
        assertEquals("/items/1", r.headers().firstValue("Location").orElse(""));
        assertTrue(r.body().contains("\"name\":\"alpha\""));
        assertEquals(400, request("POST", "/items", "not-json", null).statusCode());
    }
}
