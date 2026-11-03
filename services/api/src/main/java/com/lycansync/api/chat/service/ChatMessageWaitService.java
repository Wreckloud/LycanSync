package com.lycansync.api.chat.service;

import com.lycansync.api.auth.model.AuthenticatedUser;
import com.lycansync.api.chat.dto.ChatMessagePageResponse;
import com.lycansync.api.chat.event.ChatMessageCreatedEvent;
import com.lycansync.api.group.event.GroupChangedEvent;
import org.springframework.stereotype.Service;
import org.springframework.transaction.event.TransactionalEventListener;
import org.springframework.web.context.request.async.DeferredResult;

import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;

import static org.springframework.transaction.event.TransactionPhase.AFTER_COMMIT;

/**
 * 群聊增量长轮询；提交后唤醒，返回前重新检查群成员权限。
 *
 * @author Wreckloud
 * @since 2026-11-03
 */
@Service
public class ChatMessageWaitService {

    private final ChatService chatService;
    private final ConcurrentMap<UUID, Set<Waiter>> groups = new ConcurrentHashMap<>();
    private final ConcurrentMap<WaiterKey, Waiter> waiters = new ConcurrentHashMap<>();

    public ChatMessageWaitService(ChatService chatService) {
        this.chatService = chatService;
    }

    public DeferredResult<ChatMessagePageResponse> await(UUID groupId, AuthenticatedUser user, UUID afterMessageId,
                                                        UUID clientId, long requestId) {
        // 首次查询在注册前完成校验；注册后再查一次，覆盖消息恰在两步之间提交的情况。
        ChatMessagePageResponse page = chatService.findMessages(groupId, user, null, afterMessageId);
        Waiter waiter = new Waiter(groupId, user, afterMessageId, new WaiterKey(user.id(), clientId), requestId);
        if (!page.messages().isEmpty()) {
            waiter.result.setResult(page);
            return waiter.result;
        }
        waiter.result.onTimeout(() -> complete(waiter, true));
        waiter.result.onError(error -> remove(waiter));
        waiter.result.onCompletion(() -> remove(waiter));
        Waiter previous;
        while (true) {
            previous = waiters.get(waiter.key);
            if (previous != null && previous.requestId >= requestId) {
                waiter.result.setResult(page);
                return waiter.result;
            }
            if (previous == null ? waiters.putIfAbsent(waiter.key, waiter) == null
                    : waiters.replace(waiter.key, previous, waiter)) break;
        }
        if (previous != null) {
            previous.result.setResult(new ChatMessagePageResponse(List.of(), false));
            remove(previous);
        }
        groups.compute(groupId, (id, pending) -> {
            if (waiters.get(waiter.key) != waiter) return pending;
            if (pending == null) pending = ConcurrentHashMap.newKeySet();
            pending.add(waiter);
            return pending;
        });
        complete(waiter, false);
        return waiter.result;
    }

    @TransactionalEventListener(phase = AFTER_COMMIT)
    public void messageCreated(ChatMessageCreatedEvent event) {
        wake(event.groupId());
    }

    @TransactionalEventListener(phase = AFTER_COMMIT)
    public void groupChanged(GroupChangedEvent event) {
        wake(event.groupId());
    }

    private void wake(UUID groupId) {
        var pending = groups.get(groupId);
        if (pending != null) pending.forEach(waiter -> complete(waiter, false));
    }

    private void complete(Waiter waiter, boolean timeout) {
        if (waiter.result.isSetOrExpired()) { remove(waiter); return; }
        try {
            ChatMessagePageResponse page = chatService.findMessages(waiter.groupId, waiter.user, null, waiter.afterMessageId);
            if (timeout || !page.messages().isEmpty()) {
                waiter.result.setResult(page);
                remove(waiter);
            }
        } catch (RuntimeException exception) {
            waiter.result.setErrorResult(exception);
            remove(waiter);
        }
    }

    private void remove(Waiter waiter) {
        waiters.remove(waiter.key, waiter);
        groups.computeIfPresent(waiter.groupId, (id, pending) -> {
            pending.remove(waiter);
            return pending.isEmpty() ? null : pending;
        });
    }

    private record WaiterKey(UUID userId, UUID clientId) {
    }

    private static final class Waiter {
        private final UUID groupId;
        private final AuthenticatedUser user;
        private final UUID afterMessageId;
        private final WaiterKey key;
        private final long requestId;
        private final DeferredResult<ChatMessagePageResponse> result = new DeferredResult<>(25_000L);

        private Waiter(UUID groupId, AuthenticatedUser user, UUID afterMessageId, WaiterKey key, long requestId) {
            this.groupId = groupId;
            this.user = user;
            this.afterMessageId = afterMessageId;
            this.key = key;
            this.requestId = requestId;
        }
    }
}
