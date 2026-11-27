package com.lycansync.api.diagnostics.service;

import com.lycansync.api.auth.mapper.AuthMapper;
import com.lycansync.api.auth.model.AuthUser;
import com.lycansync.api.auth.model.AuthenticatedUser;
import com.lycansync.api.auth.service.OwnerSettingsService;
import com.lycansync.api.group.exception.GroupException;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Instant;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class DiagnosticReportRequestsTest {
    private final AuthMapper users = mock(AuthMapper.class);
    private final OwnerSettingsService owners = mock(OwnerSettingsService.class);
    private final Clock clock = mock(Clock.class);
    private final DiagnosticReportRequests requests = new DiagnosticReportRequests(owners, users, clock);
    private final AuthenticatedUser owner = new AuthenticatedUser(UUID.randomUUID(), "服主", true);
    private final UUID member = UUID.randomUUID();

    @Test
    void onlyTargetClaimsOnceUntilRequestExpires() {
        Instant now = Instant.parse("2026-11-27T12:00:00Z");
        when(clock.instant()).thenReturn(now);
        when(users.findUserProfile(member)).thenReturn(new AuthUser(member, "成员", "", false, "", now));
        requests.request(owner, member);
        assertFalse(requests.claim(owner.id()));
        assertTrue(requests.claim(member));
        assertFalse(requests.claim(member));
        assertThrows(GroupException.class, () -> requests.request(owner, member));
        when(clock.instant()).thenReturn(now.plusSeconds(121));
        requests.request(owner, member);
        when(clock.instant()).thenReturn(now.plusSeconds(241));
        assertFalse(requests.claim(member));
    }

    @Test
    void checksOwnerBeforeLookingUpMember() {
        doThrow(new IllegalStateException()).when(owners).requireOwner(owner);
        assertThrows(IllegalStateException.class, () -> requests.request(owner, member));
        verifyNoInteractions(users);
        assertFalse(requests.claim(member));
    }
}
