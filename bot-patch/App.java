package org.example;

import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.TextComponent;
import net.raphimc.minecraftauth.MinecraftAuth;
import net.raphimc.minecraftauth.java.JavaAuthManager;
import net.raphimc.minecraftauth.java.model.MinecraftProfile;
import net.raphimc.minecraftauth.msa.model.MsaDeviceCode;
import net.raphimc.minecraftauth.msa.service.impl.DeviceCodeMsaAuthService;
import org.geysermc.mcprotocollib.auth.GameProfile;
import org.geysermc.mcprotocollib.network.ClientSession;
import org.geysermc.mcprotocollib.network.Session;
import org.geysermc.mcprotocollib.network.event.session.ConnectedEvent;
import org.geysermc.mcprotocollib.network.event.session.DisconnectedEvent;
import org.geysermc.mcprotocollib.network.event.session.SessionAdapter;
import org.geysermc.mcprotocollib.network.factory.ClientNetworkSessionFactory;
import org.geysermc.mcprotocollib.network.packet.Packet;
import org.geysermc.mcprotocollib.protocol.MinecraftProtocol;
import org.geysermc.mcprotocollib.protocol.data.game.chat.ChatTypeDecoration;
import org.geysermc.mcprotocollib.protocol.packet.ingame.clientbound.ClientboundPlayerChatPacket;
import org.geysermc.mcprotocollib.protocol.packet.ingame.clientbound.ClientboundSystemChatPacket;
import org.geysermc.mcprotocollib.protocol.packet.ingame.serverbound.ServerboundChatCommandPacket;
import org.geysermc.mcprotocollib.protocol.packet.login.clientbound.ClientboundCustomQueryPacket;
import org.geysermc.mcprotocollib.protocol.packet.login.serverbound.ServerboundCustomQueryAnswerPacket;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;
import java.util.regex.Pattern;

public final class App {
    private static final Pattern SIX_DIGIT_CODE = Pattern.compile("^\\d{6}$");
    private static final Pattern MINECRAFT_USERNAME = Pattern.compile("^[A-Za-z0-9_]{3,16}$");
    // DonutSMP currently emits receipts such as "Astro2G paid you $ 500K".
    // The optional whitespace after '$' is significant: accepting it makes the
    // parser agree with the server's actual, signed system-chat formatting.
    private static final Pattern PAYMENT_RECEIVED_PATTERN = Pattern.compile("^.*?(?:received|receive)\\s+(?:a\\s+)?(?:payment\\s+(?:of|for)\\s+)?\\$?\\s*([0-9][0-9,._]*[kKmMbB]?)(?:\\s+(?:coins?|money))?\\s+from\\s+([A-Za-z0-9_]{3,16}).*$", Pattern.CASE_INSENSITIVE);
    private record VerificationMessage(String minecraftUsername, String code) { }
    private record PaymentMessage(String minecraftUsername, long amount) { }
    private record Withdrawal(String id, String minecraftUsername, long amount) { }
    private record AuthenticatedMinecraftAccount(MinecraftProfile profile, String accessToken) { }

    public static void main(String[] args) throws Exception {
        System.out.println("========================================");
        System.out.println("       DonutWagersBot");
        System.out.println("========================================");
        System.out.println();

        String backendUrl = requiredEnvironment("DONUT_WAGERS_API_URL");
        String webhookSecret = requiredEnvironment("DONUT_WAGERS_BOT_WEBHOOK_SECRET");
        List<Pattern> privateMessagePatterns = privateMessagePatterns();
        boolean debugChat = Boolean.parseBoolean(environment("DONUT_WAGERS_DEBUG_CHAT", "false"));
        HttpClient backendClient = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();

        System.out.println("Starting Microsoft authentication...");
        Consumer<MsaDeviceCode> deviceCodeConsumer = deviceCode -> {
            System.out.println();
            System.out.println("========================================");
            System.out.println("       MICROSOFT LOGIN REQUIRED");
            System.out.println("========================================");
            System.out.println();
            System.out.println("Open this URL in your browser:");
            System.out.println();
            System.out.println(deviceCode.getDirectVerificationUri());
            System.out.println();
            System.out.println("Complete the Microsoft login there.");
            System.out.println("DO NOT send the login code or password here.");
            System.out.println();
            System.out.println("========================================");
        };

        JavaAuthManager authManager = JavaAuthManager.create(MinecraftAuth.createHttpClient())
                .login(DeviceCodeMsaAuthService::new, deviceCodeConsumer);
        AuthenticatedMinecraftAccount authenticatedAccount = refreshMinecraftAccount(authManager);
        MinecraftProfile profile = authenticatedAccount.profile();
        String accessToken = authenticatedAccount.accessToken();
        String botUsername = environment("DONUT_WAGERS_BOT_USERNAME", profile.getName());
        List<Pattern> paymentPatterns = paymentPatterns(botUsername);

        System.out.println();
        System.out.println("Microsoft authentication successful!");
        System.out.println("Minecraft username: " + profile.getName());
        System.out.println("Listening for private verification messages as: " + botUsername);
        System.out.println("Connecting to Donut SMP...");
        System.out.println();

        while (!Thread.currentThread().isInterrupted()) {
            MinecraftProtocol protocol = new MinecraftProtocol(new GameProfile(profile.getId(), profile.getName()), accessToken);
            ClientSession client = ClientNetworkSessionFactory.factory()
                    .setAddress("donutsmp.net", 25565)
                    .setProtocol(protocol)
                    .create();
            CountDownLatch disconnected = new CountDownLatch(1);
            ScheduledExecutorService heartbeat = Executors.newSingleThreadScheduledExecutor(runnable -> {
                Thread thread = new Thread(runnable, "DonutWagersBot-heartbeat");
                thread.setDaemon(true);
                return thread;
            });
            AtomicBoolean withdrawalBusy = new AtomicBoolean(false);

            client.addListener(new SessionAdapter() {
                @Override
                public void connected(ConnectedEvent event) {
                    System.out.println("Bot is online and waiting for private verification messages.");
                    forwardBotHeartbeat(backendClient, backendUrl, webhookSecret, botUsername, true);
                    heartbeat.scheduleAtFixedRate(() -> forwardBotHeartbeat(backendClient, backendUrl, webhookSecret, botUsername, false), 20, 20, TimeUnit.SECONDS);
                    heartbeat.scheduleWithFixedDelay(() -> pollWithdrawal(backendClient, backendUrl, webhookSecret, client, withdrawalBusy), 5, 5, TimeUnit.SECONDS);
                }

            @Override
            public void packetReceived(Session session, Packet packet) {
                if (packet instanceof ClientboundCustomQueryPacket query) {
                    if (debugChat) System.out.printf("Login custom query: channel=%s id=%d%n", query.getChannel(), query.getMessageId());
                    session.send(new ServerboundCustomQueryAnswerPacket(query.getMessageId()));
                    return;
                }

                if (packet instanceof ClientboundPlayerChatPacket chat) {
                        String message = chat.getContent().trim();
                        String sender = plainText(chat.getName()).trim();
                        String target = chat.getTargetName() == null ? "" : plainText(chat.getTargetName()).trim();
                        if (debugChat) System.out.printf("Player chat: sender=%s target=%s content=%s%n", sender, target, message);
                        if (!isPrivateMessageForThisBot(chat, target) || !SIX_DIGIT_CODE.matcher(message).matches() || !MINECRAFT_USERNAME.matcher(sender).matches() || sender.equalsIgnoreCase(botUsername)) return;
                        System.out.printf("Received verification request from %s.%n", sender);
                        forwardVerification(backendClient, backendUrl, webhookSecret, message, sender, chat.getSender().toString());
                        return;
                    }

                    if (packet instanceof ClientboundSystemChatPacket systemChat) {
                        String message = plainText(systemChat.getContent()).trim();
                        if (debugChat) {
                            System.out.printf("System chat: %s%n", message);
                            appendDiagnosticMessage(message);
                        }
                        VerificationMessage verification = extractSystemPrivateMessage(message, privateMessagePatterns, botUsername);
                        if (verification != null) {
                            System.out.printf("Received verification request from %s.%n", verification.minecraftUsername());
                            forwardVerification(backendClient, backendUrl, webhookSecret, verification.code(), verification.minecraftUsername(), null);
                            return;
                        }
                        PaymentMessage payment = extractPayment(message, paymentPatterns, botUsername);
                        if (payment != null) {
                            System.out.printf("Received payment confirmation from %s for %,d.%n", payment.minecraftUsername(), payment.amount());
                            forwardDeposit(backendClient, backendUrl, webhookSecret, payment.minecraftUsername(), payment.amount());
                        }
                    }
                }

                @Override
                public void disconnected(DisconnectedEvent event) {
                    System.out.println("Disconnected from Donut SMP: " + event.getReason());
                    if (event.getCause() != null) event.getCause().printStackTrace();
                    heartbeat.shutdownNow();
                    disconnected.countDown();
                }
            });

            try {
                client.connect();
                disconnected.await();
            } catch (Exception error) {
                System.err.println("Connection error:");
                error.printStackTrace();
            } finally {
                heartbeat.shutdownNow();
            }
            System.out.println("Reconnecting to Donut SMP in 10 seconds…");
            Thread.sleep(10_000);
        }
    }

    private static AuthenticatedMinecraftAccount refreshMinecraftAccount(JavaAuthManager authManager) throws Exception {
        Exception lastFailure = null;
        for (int attempt = 1; attempt <= 6; attempt++) {
            try {
                MinecraftProfile profile = authManager.getMinecraftProfile().getUpToDate();
                String accessToken = authManager.getMinecraftToken().getUpToDate().getToken();
                return new AuthenticatedMinecraftAccount(profile, accessToken);
            } catch (Exception error) {
                lastFailure = error;
                if (!isTemporaryMinecraftAuthFailure(error) || attempt == 6) throw error;
                long delaySeconds = Math.min(30, attempt * 5L);
                System.err.printf("Minecraft authentication service returned a temporary error. Retrying in %d seconds (%d/6).%n", delaySeconds, attempt);
                Thread.sleep(delaySeconds * 1000L);
            }
        }
        throw lastFailure;
    }

    private static boolean isTemporaryMinecraftAuthFailure(Throwable error) {
        for (Throwable current = error; current != null; current = current.getCause()) {
            String message = String.valueOf(current.getMessage()).toLowerCase(Locale.ROOT);
            if (message.contains("500 internal server error") || message.contains("internal_server_error") || message.contains("status: 502") || message.contains("status: 503") || message.contains("status: 504")) return true;
        }
        return false;
    }

    private static void forwardVerification(HttpClient client, String backendUrl, String secret, String code, String minecraftUsername, String minecraftUuid) {
        String endpoint = backendUrl.replaceAll("/+$", "") + "/api/minecraft/verification/complete";
        String payload = "{\"code\":\"" + code + "\",\"minecraftUsername\":\"" + minecraftUsername + "\"}";
        if (minecraftUuid != null) payload = payload.substring(0, payload.length() - 1) + ",\"minecraftUuid\":\"" + minecraftUuid + "\"}";
        HttpRequest request = HttpRequest.newBuilder(URI.create(endpoint))
                .timeout(Duration.ofSeconds(15))
                .header("Content-Type", "application/json")
                .header("Authorization", "Bearer " + secret)
                .POST(HttpRequest.BodyPublishers.ofString(payload, StandardCharsets.UTF_8))
                .build();
        client.sendAsync(request, HttpResponse.BodyHandlers.ofString())
                .whenComplete((response, error) -> {
                    if (error != null) {
                        System.err.println("Unable to complete verification: " + error.getMessage());
                    } else if (response.statusCode() >= 200 && response.statusCode() < 300) {
                        System.out.printf("Verified Minecraft account %s.%n", minecraftUsername);
                    } else {
                        System.err.printf("Verification rejected for %s (HTTP %d): %s%n", minecraftUsername, response.statusCode(), response.body());
                    }
                });
    }

    private static void forwardDeposit(HttpClient client, String backendUrl, String secret, String minecraftUsername, long amount) {
        String endpoint = backendUrl.replaceAll("/+$", "") + "/api/wallet/deposits/complete";
        String payload = "{\"minecraftUsername\":\"" + minecraftUsername + "\",\"amount\":" + amount + "}";
        HttpRequest request = HttpRequest.newBuilder(URI.create(endpoint))
                .timeout(Duration.ofSeconds(15))
                .header("Content-Type", "application/json")
                .header("Authorization", "Bearer " + secret)
                .POST(HttpRequest.BodyPublishers.ofString(payload, StandardCharsets.UTF_8))
                .build();
        client.sendAsync(request, HttpResponse.BodyHandlers.ofString())
                .whenComplete((response, error) -> {
                    if (error != null) {
                        System.err.println("Unable to verify deposit: " + error.getMessage());
                    } else if (response.statusCode() >= 200 && response.statusCode() < 300) {
                        System.out.printf("Credited %,d to %s's DonutWagers wallet.%n", amount, minecraftUsername);
                    } else {
                        System.err.printf("Deposit not credited for %s (HTTP %d): %s%n", minecraftUsername, response.statusCode(), response.body());
                    }
                });
    }

    private static void forwardBotHeartbeat(HttpClient client, String backendUrl, String secret, String botUsername, boolean announce) {
        String endpoint = backendUrl.replaceAll("/+$", "") + "/api/bot/heartbeat";
        String payload = "{\"botUsername\":\"" + botUsername + "\"}";
        HttpRequest request = HttpRequest.newBuilder(URI.create(endpoint))
                .timeout(Duration.ofSeconds(15))
                .header("Content-Type", "application/json")
                .header("Authorization", "Bearer " + secret)
                .POST(HttpRequest.BodyPublishers.ofString(payload, StandardCharsets.UTF_8))
                .build();
        client.sendAsync(request, HttpResponse.BodyHandlers.ofString())
                .whenComplete((response, error) -> {
                    if (error != null) {
                        System.err.println("Unable to send bot heartbeat: " + error.getMessage());
                    } else if (response.statusCode() >= 200 && response.statusCode() < 300) {
                        if (announce) System.out.println("DonutWagers website connection confirmed.");
                    } else {
                        System.err.printf("Bot heartbeat rejected (HTTP %d): %s%n", response.statusCode(), response.body());
                    }
                });
    }

    private static void pollWithdrawal(HttpClient client, String backendUrl, String secret, Session session, AtomicBoolean busy) {
        if (!busy.compareAndSet(false, true)) return;
        String endpoint = backendUrl.replaceAll("/+$", "") + "/api/wallet/withdrawals/next";
        HttpRequest request = HttpRequest.newBuilder(URI.create(endpoint))
                .timeout(Duration.ofSeconds(15))
                .header("Content-Type", "application/json")
                .header("Authorization", "Bearer " + secret)
                .POST(HttpRequest.BodyPublishers.ofString("{}", StandardCharsets.UTF_8))
                .build();
        client.sendAsync(request, HttpResponse.BodyHandlers.ofString()).whenComplete((response, error) -> {
            if (error != null) {
                System.err.println("Unable to check withdrawal queue: " + error.getMessage());
                busy.set(false);
                return;
            }
            if (response.statusCode() == 204) { busy.set(false); return; }
            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                System.err.printf("Withdrawal queue rejected (HTTP %d): %s%n", response.statusCode(), response.body());
                busy.set(false);
                return;
            }
            Withdrawal withdrawal = parseWithdrawal(response.body());
            if (withdrawal == null) {
                System.err.println("Withdrawal queue returned an invalid payout.");
                busy.set(false);
                return;
            }
            try {
                session.send(new ServerboundChatCommandPacket("pay " + withdrawal.minecraftUsername() + " " + withdrawal.amount()));
                System.out.printf("Sent withdrawal command for %,d to %s.%n", withdrawal.amount(), withdrawal.minecraftUsername());
                forwardWithdrawalResult(client, backendUrl, secret, withdrawal.id(), true, null, busy);
            } catch (Exception sendError) {
                System.err.println("Unable to send withdrawal command: " + sendError.getMessage());
                forwardWithdrawalResult(client, backendUrl, secret, withdrawal.id(), false, sendError.getMessage(), busy);
            }
        });
    }

    private static Withdrawal parseWithdrawal(String body) {
        var id = Pattern.compile("\\\"id\\\"\\s*:\\s*\\\"([^\\\"]+)\\\"").matcher(body);
        var username = Pattern.compile("\\\"minecraft_username\\\"\\s*:\\s*\\\"([A-Za-z0-9_]{3,16})\\\"").matcher(body);
        var amount = Pattern.compile("\\\"amount\\\"\\s*:\\s*(\\d+)").matcher(body);
        if (!id.find() || !username.find() || !amount.find()) return null;
        try { return new Withdrawal(id.group(1), username.group(1), Long.parseLong(amount.group(1))); }
        catch (RuntimeException error) { return null; }
    }

    private static void forwardWithdrawalResult(HttpClient client, String backendUrl, String secret, String id, boolean success, String errorMessage, AtomicBoolean busy) {
        String endpoint = backendUrl.replaceAll("/+$", "") + "/api/wallet/withdrawals/" + id + "/complete";
        String safeError = errorMessage == null ? "" : errorMessage.replace("\\", "\\\\").replace("\"", "\\\"");
        String payload = "{\"success\":" + success + (success ? "" : ",\"error\":\"" + safeError + "\"") + "}";
        HttpRequest request = HttpRequest.newBuilder(URI.create(endpoint))
                .timeout(Duration.ofSeconds(15))
                .header("Content-Type", "application/json")
                .header("Authorization", "Bearer " + secret)
                .POST(HttpRequest.BodyPublishers.ofString(payload, StandardCharsets.UTF_8))
                .build();
        client.sendAsync(request, HttpResponse.BodyHandlers.ofString()).whenComplete((response, requestError) -> {
            if (requestError != null) System.err.println("Unable to confirm withdrawal: " + requestError.getMessage());
            else if (response.statusCode() < 200 || response.statusCode() >= 300) System.err.printf("Withdrawal completion rejected (HTTP %d): %s%n", response.statusCode(), response.body());
            else System.out.println(success ? "Withdrawal marked complete." : "Failed withdrawal released.");
            busy.set(false);
        });
    }

    /**
     * Keeps an on-device record of server-generated chat only when diagnostic mode
     * is enabled. This makes an unrecognised payment confirmation actionable
     * without trusting regular player chat as a payment signal.
     */
    private static void appendDiagnosticMessage(String message) {
        try {
            Files.writeString(
                    Path.of("donutwagers-bot.log"),
                    Instant.now() + " System chat: " + message + System.lineSeparator(),
                    StandardCharsets.UTF_8,
                    StandardOpenOption.CREATE,
                    StandardOpenOption.APPEND
            );
        } catch (Exception ignored) {
            // Diagnostics must never interrupt payment forwarding.
        }
    }

    private static String plainText(Component component) {
        StringBuilder value = new StringBuilder();
        appendPlainText(component, value);
        return value.toString();
    }

    private static void appendPlainText(Component component, StringBuilder value) {
        if (component instanceof TextComponent text) value.append(text.content());
        for (Component child : component.children()) appendPlainText(child, value);
    }

    private static boolean isPrivateMessageForThisBot(ClientboundPlayerChatPacket chat, String target) {
        // A target name only exists for targeted player chat. Servers may display it as the
        // recipient name or as “You”, so it must not be compared to the bot's own name.
        if (!target.isBlank()) return true;
        if (!chat.getChatType().isCustom()) return false;
        ChatTypeDecoration decoration = chat.getChatType().custom().chat();
        String translationKey = decoration.translationKey();
        return translationKey.equals("commands.message.display.incoming") || translationKey.endsWith(".message.incoming");
    }

    private static List<Pattern> privateMessagePatterns() {
        List<Pattern> patterns = new ArrayList<>();
        String expression = System.getenv("DONUT_WAGERS_PRIVATE_MESSAGE_REGEX");
        if (expression != null && !expression.isBlank()) {
            Pattern pattern = Pattern.compile(expression);
            if (pattern.matcher("").groupCount() < 2) {
                throw new IllegalStateException("DONUT_WAGERS_PRIVATE_MESSAGE_REGEX must have capture group 1 for the sender and group 2 for the six-digit code.");
            }
            patterns.add(pattern);
        }
        patterns.add(Pattern.compile("^(?:From\\s+)?([A-Za-z0-9_]{3,16})\\s*(?::|»|→|->)\\s*(\\d{6})$", Pattern.CASE_INSENSITIVE));
        patterns.add(Pattern.compile("^([A-Za-z0-9_]{3,16})\\s+(?:whispers?|messages?)\\s+to\\s+(?:you|[A-Za-z0-9_]{3,16})\\s*(?::|»|→|->)\\s*(\\d{6})$", Pattern.CASE_INSENSITIVE));
        patterns.add(Pattern.compile("^\\[?(?:PM|MSG|WHISPER)\\]?\\s*(?:From\\s+)?([A-Za-z0-9_]{3,16})\\s*(?::|»|→|->)\\s*(\\d{6})$", Pattern.CASE_INSENSITIVE));
        return patterns;
    }

    private static List<Pattern> paymentPatterns(String botUsername) {
        List<Pattern> patterns = new ArrayList<>();
        String expression = System.getenv("DONUT_WAGERS_PAYMENT_REGEX");
        if (expression != null && !expression.isBlank()) {
            Pattern pattern = Pattern.compile(expression);
            if (pattern.matcher("").groupCount() < 2) {
                throw new IllegalStateException("DONUT_WAGERS_PAYMENT_REGEX must have capture group 1 for the sender and group 2 for the amount.");
            }
            patterns.add(pattern);
        }
        patterns.add(Pattern.compile("^([A-Za-z0-9_]{3,16})\\s+(?:has\\s+)?(?:paid|sent)\\s+(?:you|" + Pattern.quote(botUsername) + ")\\s+\\$?\\s*([0-9][0-9,._]*[kKmMbB]?).*$", Pattern.CASE_INSENSITIVE));
        patterns.add(Pattern.compile("^(?:Payment\\s+)?(?:received\\s+)?from\\s+([A-Za-z0-9_]{3,16})\\s*(?::|-)?\\s*\\$?\\s*([0-9][0-9,._]*[kKmMbB]?).*$", Pattern.CASE_INSENSITIVE));
        return patterns;
    }

    private static PaymentMessage extractPayment(String message, List<Pattern> patterns, String botUsername) {
        var received = PAYMENT_RECEIVED_PATTERN.matcher(message);
        if (received.matches()) {
            Long amount = parseAmount(received.group(1));
            String sender = received.group(2);
            if (amount != null && MINECRAFT_USERNAME.matcher(sender).matches() && !sender.equalsIgnoreCase(botUsername)) {
                return new PaymentMessage(sender, amount);
            }
        }
        for (Pattern pattern : patterns) {
            var matcher = pattern.matcher(message);
            if (!matcher.matches()) continue;
            String sender = matcher.group(1);
            Long amount = parseAmount(matcher.group(2));
            if (amount != null && MINECRAFT_USERNAME.matcher(sender).matches() && !sender.equalsIgnoreCase(botUsername)) {
                return new PaymentMessage(sender, amount);
            }
        }
        return null;
    }

    private static Long parseAmount(String value) {
        try {
            String normalized = value.replaceAll("[,_]", "").trim().toLowerCase();
            BigDecimal multiplier = BigDecimal.ONE;
            if (normalized.endsWith("k")) { multiplier = BigDecimal.valueOf(1_000); normalized = normalized.substring(0, normalized.length() - 1); }
            if (normalized.endsWith("m")) { multiplier = BigDecimal.valueOf(1_000_000); normalized = normalized.substring(0, normalized.length() - 1); }
            if (normalized.endsWith("b")) { multiplier = BigDecimal.valueOf(1_000_000_000); normalized = normalized.substring(0, normalized.length() - 1); }
            long amount = new BigDecimal(normalized).multiply(multiplier).setScale(0, RoundingMode.UNNECESSARY).longValueExact();
            return amount >= 100_000 ? amount : null;
        } catch (RuntimeException error) {
            return null;
        }
    }

    private static VerificationMessage extractSystemPrivateMessage(String message, List<Pattern> patterns, String botUsername) {
        for (Pattern pattern : patterns) {
            var matcher = pattern.matcher(message);
            if (!matcher.matches()) continue;
            String sender = matcher.group(1);
            String code = matcher.group(2);
            if (MINECRAFT_USERNAME.matcher(sender).matches() && SIX_DIGIT_CODE.matcher(code).matches() && !sender.equalsIgnoreCase(botUsername)) {
                return new VerificationMessage(sender, code);
            }
        }
        return null;
    }

    private static String requiredEnvironment(String key) {
        String value = System.getenv(key);
        if (value == null || value.isBlank()) throw new IllegalStateException(key + " must be set before starting DonutWagersBot.");
        return value.trim();
    }

    private static String environment(String key, String fallback) {
        String value = System.getenv(key);
        return value == null || value.isBlank() ? fallback : value.trim();
    }
}
