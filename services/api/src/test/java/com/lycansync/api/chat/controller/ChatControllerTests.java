package com.lycansync.api.chat.controller;

import com.lycansync.api.auth.model.AuthenticatedUser;
import com.lycansync.api.chat.dto.ChatMessagePageResponse;
import com.lycansync.api.chat.service.ChatFileService;
import com.lycansync.api.chat.service.ChatMessageWaitService;
import com.lycansync.api.chat.service.ChatService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.method.annotation.AuthenticationPrincipalArgumentResolver;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.context.request.async.DeferredResult;

import java.util.List;
import java.util.UUID;

import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.asyncDispatch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.request;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 查询与等待共用消息路径时的路由和异步响应验证，不启动服务器。
 *
 * @author Wreckloud
 * @since 2026-11-03
 */
class ChatControllerTests {

    private final ChatService chat = mock(ChatService.class);
    private final ChatMessageWaitService waits = mock(ChatMessageWaitService.class);
    private final UUID groupId = UUID.randomUUID();
    private final UUID cursor = UUID.randomUUID();
    private final UUID clientId = UUID.randomUUID();
    private final AuthenticatedUser user = new AuthenticatedUser(UUID.randomUUID(), "测试成员", false);
    private MockMvc mvc;

    @BeforeEach
    void setUp() {
        SecurityContextHolder.getContext().setAuthentication(new UsernamePasswordAuthenticationToken(user, null, List.of()));
        mvc = MockMvcBuilders.standaloneSetup(new ChatController(chat, mock(ChatFileService.class), waits))
                .setCustomArgumentResolvers(new AuthenticationPrincipalArgumentResolver()).build();
    }

    @AfterEach
    void tearDown() {
        SecurityContextHolder.clearContext();
    }

    @Test
    void aNormalHistoryRequestDoesNotStartAnAsyncWait() throws Exception {
        when(chat.findMessages(groupId, user, cursor, null)).thenReturn(new ChatMessagePageResponse(List.of(), true));
        mvc.perform(get("/api/groups/{groupId}/messages", groupId).param("beforeMessageId", cursor.toString()))
                .andExpect(status().isOk()).andExpect(request().asyncNotStarted())
                .andExpect(jsonPath("$.hasMore").value(true));
        verifyNoInteractions(waits);
    }

    @Test
    void waitSelectsTheAsyncRouteAndKeepsTheIncrementCursorAndIdentity() throws Exception {
        DeferredResult<ChatMessagePageResponse> pending = new DeferredResult<>(25_000L);
        when(waits.await(groupId, user, cursor, clientId, 1)).thenReturn(pending);
        var result = mvc.perform(get("/api/groups/{groupId}/messages", groupId)
                        .param("wait", "true").param("afterMessageId", cursor.toString())
                        .param("clientId", clientId.toString()).param("requestId", "1"))
                .andExpect(request().asyncStarted()).andReturn();
        pending.setResult(new ChatMessagePageResponse(List.of(), false));
        mvc.perform(asyncDispatch(result)).andExpect(status().isOk()).andExpect(jsonPath("$.messages").isEmpty());
        verify(waits).await(groupId, user, cursor, clientId, 1);
        verifyNoInteractions(chat);
    }
}
