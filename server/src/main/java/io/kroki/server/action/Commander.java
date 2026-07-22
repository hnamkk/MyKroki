package io.kroki.server.action;

import io.kroki.server.unit.TimeValue;
import io.vertx.core.json.JsonObject;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.*;
import java.util.Arrays;
import java.util.concurrent.TimeUnit;

public class Commander {

  private static final Logger logger = LoggerFactory.getLogger(Commander.class);
  protected TimeValue commandTimeout;
  protected TimeValue readStdoutTimeout;
  protected TimeValue readStderrTimeout;
  private final CommandStatusHandler commandStatusHandler;

  public Commander(JsonObject config) {
    this(config, new CommandStatusHandler() {
      public byte[] handle(int exitValue, byte[] stdout, byte[] stderr) {
        return CommandStatusHandler.super.handle(exitValue, stdout, stderr);
      }
    });
  }

  public Commander(JsonObject config, CommandStatusHandler commandStatusHandler) {
    String commandTimeoutValue = config.getString("KROKI_COMMAND_TIMEOUT", "5s");
    this.commandTimeout = TimeValue.parseTimeValue(commandTimeoutValue, "KROKI_COMMAND_TIMEOUT");
    String readStdoutTimeoutValue = config.getString("KROKI_COMMAND_READ_STDOUT_TIMEOUT", "2s");
    this.readStdoutTimeout = TimeValue.parseTimeValue(readStdoutTimeoutValue, "KROKI_COMMAND_READ_STDOUT_TIMEOUT");
    String readStderrTimeoutValue = config.getString("KROKI_COMMAND_READ_STDERR_TIMEOUT", "2s");
    this.readStderrTimeout = TimeValue.parseTimeValue(readStderrTimeoutValue, "KROKI_COMMAND_READ_STDERR_TIMEOUT");
    this.commandStatusHandler = commandStatusHandler;
  }

  public byte[] execute(byte[] source, String... cmd) throws IOException, InterruptedException, IllegalStateException {
    ProcessBuilder builder = new ProcessBuilder();
    builder.command(cmd);
    //builder.redirectError(ProcessBuilder.Redirect.PIPE);
    //builder.redirectInput(ProcessBuilder.Redirect.PIPE);
    Process process = builder.start();

    ByteArrayOutputStream stdoutBuffer = new ByteArrayOutputStream();
    Thread processStdoutReader = readProcessStdout(process, stdoutBuffer);
    ByteArrayOutputStream stderrBuffer = new ByteArrayOutputStream();
    Thread readProcessStderr = readProcessStderr(process, stderrBuffer);

    try {
      OutputStream stdin = process.getOutputStream();
      stdin.write(source);
      stdin.flush();
      stdin.close();

      boolean completed = process.waitFor(this.commandTimeout.duration(), this.commandTimeout.timeUnit());
      if (!completed) {
        terminateProcessTree(process);
        processStdoutReader.join(readStdoutTimeout.millis());
        readProcessStderr.join(readStderrTimeout.millis());
        throw new InterruptedIOException("Process was forcibly killed (not responding after " + this.commandTimeout + ")");
      }
      // Writing to stdout/stderr is asynchronous, wait until readers drain the closed streams.
      processStdoutReader.join(readStdoutTimeout.millis());
      readProcessStderr.join(readStderrTimeout.millis());
      return commandStatusHandler.handle(
        process.exitValue(),
        stdoutBuffer.toByteArray(),
        stderrBuffer.toByteArray()
      );
    } catch (InterruptedException e) {
      terminateProcessTree(process);
      Thread.currentThread().interrupt();
      throw e;
    } catch (IOException e) {
      terminateProcessTree(process);
      logger.error("Error while executing command: " + Arrays.toString(cmd), e);
      throw e;
    } finally {
      if (process.isAlive()) terminateProcessTree(process);
    }
  }

  private static void terminateProcessTree(Process process) {
    ProcessHandle[] descendants = process.descendants().toArray(ProcessHandle[]::new);
    for (int index = descendants.length - 1; index >= 0; index--) {
      descendants[index].destroyForcibly();
    }
    try {
      // A shell waiting on a child must stay alive long enough to reap it.
      // Killing the parent immediately can leave a zombie under a container PID 1
      // that does not act as an init process.
      if (!process.waitFor(500, TimeUnit.MILLISECONDS)) {
        process.destroyForcibly();
        process.waitFor(1, TimeUnit.SECONDS);
      }
    } catch (InterruptedException e) {
      process.destroyForcibly();
      Thread.currentThread().interrupt();
    }
  }

  private static Thread readProcessStdout(final Process process, final ByteArrayOutputStream buffer) {
    InputStream input = process.getInputStream();
    Thread thread = new Thread(() -> {
      byte[] data = new byte[2048];
      int index;
      try {
        while ((index = input.read(data, 0, data.length)) != -1) {
          buffer.write(data, 0, index);
        }
      } catch (IOException e) {
        throw new RuntimeException("Unable to read stdout", e);
      }
    });
    thread.start();
    return thread;
  }

  private static Thread readProcessStderr(final Process process, final ByteArrayOutputStream buffer) {
    InputStream input = process.getErrorStream();
    Thread thread = new Thread(() -> {
      byte[] data = new byte[2048];
      int index;
      try {
        while ((index = input.read(data, 0, data.length)) != -1) {
          buffer.write(data, 0, index);
        }
      } catch (IOException e) {
        throw new RuntimeException("Unable to read stderr", e);
      }
    });
    thread.start();
    return thread;
  }
}
