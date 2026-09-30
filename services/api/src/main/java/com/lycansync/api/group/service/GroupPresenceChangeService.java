package com.lycansync.api.group.service;

import com.lycansync.api.group.dto.GroupPresenceChangeResponse;
import com.lycansync.api.presence.event.PresenceChangedEvent;
import org.springframework.stereotype.Service;
import org.springframework.transaction.event.TransactionalEventListener;
import org.springframework.web.context.request.async.DeferredResult;

import java.time.Duration;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;

import static org.springframework.transaction.event.TransactionPhase.AFTER_COMMIT;

/**
 * 管理每个进程实例的群组在线状态变化游标和长轮询。
 *
 * @author Wreckloud
 * @since 2026-09-30
 */
@Service
public class GroupPresenceChangeService {

    private static final Duration WAIT_TIMEOUT = Duration.ofSeconds(45);

    private final UUID serverInstanceId = UUID.randomUUID();
    private final ConcurrentMap<UUID, GroupState> groups = new ConcurrentHashMap<>();
    private final ConcurrentMap<WaiterKey, Waiter> waiters = new ConcurrentHashMap<>();

    public DeferredResult<GroupPresenceChangeResponse> await(UUID userId, UUID groupId, UUID clientId, long requestId,
                                                              UUID previousInstanceId, Long previousVersion) {
        GroupState state = groups.computeIfAbsent(groupId, ignored -> new GroupState());
        Waiter waiter = new Waiter(new WaiterKey(userId, clientId), state, requestId);
        waiter.result.onTimeout(() -> state.timeout(waiter));
        waiter.result.onError(error -> remove(waiter));
        waiter.result.onCompletion(() -> remove(waiter));

        Waiter previous;
        while (true) {
            previous = waiters.get(waiter.key);
            if (previous != null && previous.requestId > requestId) {
                waiter.result.setResult(state.currentResponse(true));
                return waiter.result;
            }
            boolean registered = previous == null
                    ? waiters.putIfAbsent(waiter.key, waiter) == null
                    : waiters.replace(waiter.key, previous, waiter);
            if (registered) break;
        }
        if (previous != null) previous.state.complete(previous, true);
        state.register(waiter, previousInstanceId, previousVersion);
        return waiter.result;
    }

    @TransactionalEventListener(phase = AFTER_COMMIT)
    public void presenceChanged(PresenceChangedEvent event) {
        groups.values().forEach(GroupState::publish);
    }

    private void remove(Waiter waiter) {
        waiter.state.remove(waiter);
        waiters.remove(waiter.key, waiter);
    }

    private final class GroupState {

        private final Set<Waiter> pending = new HashSet<>();
        private long version;

        private void register(Waiter waiter, UUID previousInstanceId, Long previousVersion) {
            GroupPresenceChangeResponse immediate;
            synchronized (this) {
                if (waiters.get(waiter.key) == waiter && serverInstanceId.equals(previousInstanceId)
                        && previousVersion != null && previousVersion == version) {
                    waiter.observedVersion = version;
                    pending.add(waiter);
                    return;
                }
                immediate = response(version, true);
            }
            complete(waiter, immediate);
        }

        private void publish() {
            List<Waiter> recipients;
            GroupPresenceChangeResponse change;
            synchronized (this) {
                version++;
                change = response(version, true);
                recipients = new ArrayList<>(pending);
                pending.clear();
            }
            recipients.forEach(waiter -> complete(waiter, change));
        }

        private void timeout(Waiter waiter) {
            GroupPresenceChangeResponse current;
            synchronized (this) {
                pending.remove(waiter);
                current = response(version, version != waiter.observedVersion);
            }
            complete(waiter, current);
        }

        private void complete(Waiter waiter, boolean changed) {
            complete(waiter, currentResponse(changed));
        }

        private void complete(Waiter waiter, GroupPresenceChangeResponse result) {
            GroupPresenceChangeService.this.remove(waiter);
            waiter.result.setResult(result);
        }

        private synchronized GroupPresenceChangeResponse currentResponse(boolean changed) {
            return response(version, changed);
        }

        private GroupPresenceChangeResponse response(long currentVersion, boolean changed) {
            return new GroupPresenceChangeResponse(serverInstanceId, currentVersion, changed);
        }

        private synchronized void remove(Waiter waiter) {
            pending.remove(waiter);
        }
    }

    private final class Waiter {

        private final WaiterKey key;
        private final GroupState state;
        private final long requestId;
        private final DeferredResult<GroupPresenceChangeResponse> result = new DeferredResult<>(WAIT_TIMEOUT.toMillis());
        private long observedVersion;

        private Waiter(WaiterKey key, GroupState state, long requestId) {
            this.key = key;
            this.state = state;
            this.requestId = requestId;
        }
    }

    private record WaiterKey(UUID userId, UUID clientId) {
    }
}
