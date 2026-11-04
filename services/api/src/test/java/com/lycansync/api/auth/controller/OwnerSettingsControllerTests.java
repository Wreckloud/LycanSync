package com.lycansync.api.auth.controller;

import com.lycansync.api.auth.config.AccountAccessProperties;
import com.lycansync.api.auth.config.AuthConfiguration;
import com.lycansync.api.auth.config.QqLoginProperties;
import com.lycansync.api.auth.mapper.AuthMapper;
import com.lycansync.api.auth.model.AuthenticatedUser;
import com.lycansync.api.auth.model.AuthUser;
import com.lycansync.api.auth.service.AuthService;
import com.lycansync.api.auth.service.OwnerSettingsService;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

import java.time.Instant;
import java.util.UUID;

import static org.hamcrest.Matchers.containsString;
import static org.hamcrest.Matchers.hasSize;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 服主状态入口的认证、权限变更和最小字段边界。
 *
 * @author Wreckloud
 * @since 2026-11-04
 */
@WebMvcTest(OwnerSettingsController.class)
@Import({AuthConfiguration.class, OwnerSettingsService.class, AccountAccessProperties.class, QqLoginProperties.class})
class OwnerSettingsControllerTests {
    @Autowired private MockMvc mvc;
    @MockitoBean private AuthService sessions;
    @MockitoBean private AuthMapper users;

    @Test
    void anonymousAndMemberCannotReadServerSettings() throws Exception {
        mvc.perform(get("/api/auth/server-settings")).andExpect(status().isUnauthorized());
        when(sessions.authenticate("member-token")).thenReturn(new AuthenticatedUser(UUID.randomUUID(), "成员", false));
        mvc.perform(get("/api/auth/server-settings").header("Authorization", "Bearer member-token"))
                .andExpect(status().isForbidden());
        verifyNoInteractions(users);
    }

    @Test
    void formerOwnerCannotReadSettingsWithStaleIdentity() throws Exception {
        var owner = new AuthenticatedUser(UUID.randomUUID(), "原服主", true);
        when(sessions.authenticate("old-owner")).thenReturn(owner);
        when(users.findUserProfile(owner.id())).thenReturn(new AuthUser(owner.id(), "原服主", "", false, "", Instant.now()));
        mvc.perform(get("/api/auth/server-settings").header("Authorization", "Bearer old-owner"))
                .andExpect(status().isForbidden());
    }

    @Test
    void currentOwnerReceivesOnlyConfigurationFlags() throws Exception {
        var owner = new AuthenticatedUser(UUID.randomUUID(), "服主", true);
        when(sessions.authenticate("owner-token")).thenReturn(owner);
        when(users.findUserProfile(owner.id())).thenReturn(new AuthUser(owner.id(), "服主", "", true, "", Instant.now()));
        mvc.perform(get("/api/auth/server-settings").header("Authorization", "Bearer owner-token"))
                .andExpect(status().isOk()).andExpect(header().string("Cache-Control", containsString("no-store")))
                .andExpect(jsonPath("$.*", hasSize(4)))
                .andExpect(jsonPath("$.serverName").value("LycanSync"))
                .andExpect(jsonPath("$.qqEnabled").value(false))
                .andExpect(jsonPath("$.mediaConfigured").value(false));
    }
}
