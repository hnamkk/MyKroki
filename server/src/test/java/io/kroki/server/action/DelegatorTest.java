package io.kroki.server.action;

import io.vertx.core.Vertx;
import io.vertx.core.buffer.Buffer;
import io.vertx.core.http.HttpHeaders;
import io.vertx.core.http.HttpMethod;
import io.vertx.core.http.HttpServer;
import io.vertx.core.json.JsonObject;
import io.vertx.ext.web.Router;
import io.vertx.ext.web.client.HttpResponse;
import io.vertx.ext.web.client.WebClient;
import io.vertx.junit5.VertxExtension;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;

import java.io.IOException;
import java.net.ServerSocket;
import java.util.HashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

@ExtendWith(VertxExtension.class)
public class DelegatorTest {

  private int port;

  @BeforeEach
  void init() throws IOException {
    ServerSocket socket = new ServerSocket(0);
    port = socket.getLocalPort();
    socket.close();
  }

  @Test
  void should_propagate_options_when_delegating_work(Vertx vertx) throws TimeoutException {
    HttpServer server = vertx.createHttpServer();
    server.requestHandler(req -> {
      req.body().onSuccess(bodyBuffer -> {
        Buffer responseBuffer = Buffer.buffer();
        responseBuffer.appendString("uri=");
        responseBuffer.appendString(req.uri());
        responseBuffer.appendString("\n");
        responseBuffer.appendString(";body=");
        responseBuffer.appendString(bodyBuffer.toString());
        req.response().setStatusCode(200).end(responseBuffer);
      });
    });
    server.listen(port, "localhost").await(5, TimeUnit.SECONDS);
    Delegator delegator = new Delegator(vertx);
    HashMap<String, Object> options = new HashMap<>();
    options.put("theme", "forest");
    HttpResponse<Buffer> response = delegator.delegate("localhost", port, "/mermaid/png", "sequenceDiagram\n" +
      "    Alice->>John: Hello John, how are you?", new JsonObject(options)).await(5, TimeUnit.SECONDS);
    assertThat(response.bodyAsString()).isEqualTo("uri=/mermaid/png?theme=forest\n;body=sequenceDiagram\n    Alice->>John: Hello John, how are you?");
  }

  @Test
  void should_handle_redirect_with_post_method(Vertx vertx) throws TimeoutException {
    HttpServer server = vertx.createHttpServer();
    Router router = Router.router(vertx);
    router.route("/redirect")
      .handler(context -> context.response()
        .setStatusCode(301)
        .putHeader(HttpHeaders.LOCATION, "/destination")
        .end());
    router.route("/destination")
      .handler(context -> context.response()
        .setStatusCode(200)
        .end(context.request().method().name()));

    server
      .requestHandler(router)
      .listen(port, "localhost")
      .await(5, TimeUnit.SECONDS);

    Delegator delegator = new Delegator(vertx);
    HashMap<String, Object> options = new HashMap<>();
    HttpResponse<Buffer> response = delegator.delegate("localhost", port, "/redirect", "", new JsonObject(options)).await(5, TimeUnit.SECONDS);
    assertThat(response.bodyAsString()).isEqualTo(HttpMethod.POST.name());
  }

  @Test
  void should_not_propagate_companion_stack_trace(Vertx vertx) throws TimeoutException {
    HttpServer server = vertx.createHttpServer();
    server.requestHandler(req -> req.response()
      .setStatusCode(400)
      .putHeader(HttpHeaders.CONTENT_TYPE, "application/json")
      .end(new JsonObject().put("error", new JsonObject()
        .put("name", "SyntaxError")
        .put("message", "Unexpected token at line 3")
        .put("stacktrace", "SECRET_INTERNAL_STACK")).encode()));
    server.listen(port, "localhost").await(5, TimeUnit.SECONDS);

    WebClient client = WebClient.create(vertx);
    HttpResponse<Buffer> response = client.post(port, "localhost", "/render")
      .sendBuffer(Buffer.buffer("broken"))
      .await(5, TimeUnit.SECONDS);
    assertThatThrownBy(() -> Delegator.handle("localhost", port, "/render", io.vertx.core.Future.succeededFuture(response))
      .await(5, TimeUnit.SECONDS))
      .hasMessageContaining("SyntaxError: Unexpected token at line 3")
      .hasMessageNotContaining("SECRET_INTERNAL_STACK");
  }

  @Test
  void should_cancel_a_wedged_companion_request_at_configured_timeout(Vertx vertx) throws TimeoutException {
    HttpServer server = vertx.createHttpServer();
    server.requestHandler(req -> req.body().onSuccess(ignored -> { }));
    server.listen(port, "localhost").await(5, TimeUnit.SECONDS);
    Delegator delegator = new Delegator(vertx, new JsonObject().put("KROKI_DELEGATE_TIMEOUT_MS", 100L));
    long startedAt = System.nanoTime();
    assertThatThrownBy(() -> delegator.delegate("localhost", port, "/render", "source", new JsonObject())
      .await(10, TimeUnit.SECONDS))
      .isInstanceOf(Exception.class);
    assertThat(TimeUnit.NANOSECONDS.toSeconds(System.nanoTime() - startedAt)).isLessThan(5);
  }
}
