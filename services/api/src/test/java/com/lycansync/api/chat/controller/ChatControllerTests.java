package com.lycansync.api.chat.controller;

import com.lycansync.api.auth.model.AuthenticatedUser;
import com.lycansync.api.chat.dto.ChatMessagePageResponse;
import com.lycansync.api.chat.service.ChatFileService;
import com.lycansync.api.chat.service.ChatMessageWaitService;
import com.lycansync.api.chat.service.ChatService;
import com.lycansync.api.chat.service.ChatFileMediaService;
import com.lycansync.api.chat.service.ChatVideoPreviewService;
import com.lycansync.api.chat.dto.ChatVideoPreviewResponse;
import com.lycansync.api.chat.model.ChatFileMetadata;
import org.springframework.core.io.FileSystemResource;
import org.junit.jupiter.api.io.TempDir;
import java.nio.file.Files;
import java.nio.file.Path;
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
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;

/**
 * 查询与等待共用消息路径时的路由和异步响应验证，不启动服务器。
 *
 * @author Wreckloud
 * @since 2026-11-03
 */
class ChatControllerTests {

    private final ChatService chat = mock(ChatService.class);
    private final ChatFileService files = mock(ChatFileService.class);
    private final ChatFileMediaService thumbnails = mock(ChatFileMediaService.class);
    private final ChatVideoPreviewService previews = mock(ChatVideoPreviewService.class);
    @TempDir Path directory;
    private final ChatMessageWaitService waits = mock(ChatMessageWaitService.class);
    private final UUID groupId = UUID.randomUUID();
    private final UUID cursor = UUID.randomUUID();
    private final UUID clientId = UUID.randomUUID();
    private final AuthenticatedUser user = new AuthenticatedUser(UUID.randomUUID(), "测试成员", false);
    private MockMvc mvc;

    @BeforeEach
    void setUp() {
        SecurityContextHolder.getContext().setAuthentication(new UsernamePasswordAuthenticationToken(user, null, List.of()));
        mvc = MockMvcBuilders.standaloneSetup(new ChatController(chat, files, thumbnails, previews, waits))
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
    void mediaSupportsRangesWithoutLoadingTheFullFileOrChangingDownloadDisposition() throws Exception {
        UUID attachment = UUID.randomUUID();
        Path video = directory.resolve("test.mp4");
        Files.write(video, new byte[]{0, 1, 2, 3, 4, 5});
        when(files.findMetadata(groupId, attachment, user)).thenReturn(new ChatFileMetadata(attachment, "test.mp4", 6));
        when(files.findFile(attachment)).thenReturn(new FileSystemResource(video));
        String path = "/api/groups/" + groupId + "/files/" + attachment;
        mvc.perform(get(path + "/media").header("Range", "bytes=2-4"))
                .andExpect(status().isPartialContent()).andExpect(header().string("Content-Range", "bytes 2-4/6"))
                .andExpect(header().string("Accept-Ranges", "bytes")).andExpect(content().contentType("video/mp4"))
                .andExpect(content().bytes(new byte[]{2, 3, 4}));
        mvc.perform(get(path + "/media").header("Range", "bytes=9-"))
                .andExpect(status().isRequestedRangeNotSatisfiable()).andExpect(header().string("Content-Range", "bytes */6"));
        mvc.perform(get(path)).andExpect(status().isOk())
                .andExpect(header().string("Content-Disposition", org.hamcrest.Matchers.startsWith("attachment;")))
                .andExpect(content().bytes(new byte[]{0, 1, 2, 3, 4, 5}));
    }

    @Test
    void compatiblePreviewSeparatesExplicitConversionFromStatusAndRangePlayback() throws Exception {
        UUID attachment = UUID.randomUUID();
        String path = "/api/groups/" + groupId + "/files/" + attachment + "/preview";
        when(previews.status(groupId, attachment, user)).thenReturn(new ChatVideoPreviewResponse("absent", null));
        mvc.perform(get(path)).andExpect(status().isOk()).andExpect(jsonPath("$.status").value("absent"));
        org.mockito.Mockito.verify(previews, org.mockito.Mockito.never()).prepare(groupId, attachment, user);
        when(previews.prepare(groupId, attachment, user)).thenReturn(new ChatVideoPreviewResponse("processing", null));
        mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post(path))
                .andExpect(status().isOk()).andExpect(jsonPath("$.status").value("processing"));
        Path video = Files.write(directory.resolve("compatible.mp4"), new byte[]{0, 1, 2, 3});
        when(previews.find(groupId, attachment, user)).thenReturn(new FileSystemResource(video));
        mvc.perform(get(path + "/media").header("Range", "bytes=1-2"))
                .andExpect(status().isPartialContent()).andExpect(header().string("Content-Range", "bytes 1-2/4"))
                .andExpect(content().bytes(new byte[]{1, 2}));
    }

    @Test
    void thumbnailReturnsOnlyJpegOrExplicitlyNoPreview() throws Exception {
        UUID attachment = UUID.randomUUID();
        String path = "/api/groups/" + groupId + "/files/" + attachment + "/thumbnail";
        when(thumbnails.findThumbnail(groupId, attachment, user)).thenReturn(new byte[]{1, 2});
        mvc.perform(get(path)).andExpect(status().isOk()).andExpect(content().contentType("image/jpeg"))
                .andExpect(content().bytes(new byte[]{1, 2}));
        when(thumbnails.findThumbnail(groupId, attachment, user)).thenReturn(null);
        mvc.perform(get(path)).andExpect(status().isNoContent());
        String imagePath = "/api/groups/" + groupId + "/attachments/" + attachment + "/thumbnail";
        when(chat.findAttachmentThumbnail(groupId, attachment, user)).thenReturn(new byte[]{3, 4});
        mvc.perform(get(imagePath)).andExpect(status().isOk()).andExpect(content().contentType("image/jpeg"))
                .andExpect(content().bytes(new byte[]{3, 4}));
        verifyNoInteractions(files);
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
