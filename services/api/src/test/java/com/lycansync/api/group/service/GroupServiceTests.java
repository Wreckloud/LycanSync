package com.lycansync.api.group.service;

import com.lycansync.api.auth.model.AuthenticatedUser;
import com.lycansync.api.group.dto.CreateGroupRequest;
import com.lycansync.api.group.exception.GroupException;
import com.lycansync.api.group.mapper.GroupMapper;
import com.lycansync.api.group.model.ChatGroup;
import com.lycansync.api.group.model.GroupRole;
import com.lycansync.api.group.model.GroupView;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.time.Clock;
import java.util.Base64;
import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * 群组头像规范化保存与失败不写入测试。
 *
 * @author Wreckloud
 * @since 2026-10-11
 */
class GroupServiceTests {

    @Test
    void shouldStoreAndReturnNormalizedAvatar() throws Exception {
        GroupMapper mapper = mock(GroupMapper.class);
        AuthenticatedUser user = new AuthenticatedUser(UUID.randomUUID(), "群主", false);
        ArgumentCaptor<ChatGroup> inserted = ArgumentCaptor.forClass(ChatGroup.class);
        when(mapper.findGroup(any(UUID.class), eq(user.id()))).thenAnswer(invocation -> {
            ChatGroup group = inserted.getValue();
            return new GroupView(group.id(), group.name(), group.description(), group.avatar(),
                    GroupRole.OWNER, 1, group.createdAt(), group.updatedAt());
        });
        when(mapper.findMembers(any(UUID.class))).thenReturn(List.of());
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        ImageIO.write(new BufferedImage(512, 512, BufferedImage.TYPE_INT_ARGB), "png", output);
        String avatar = "data:image/png;base64," + Base64.getEncoder().encodeToString(output.toByteArray());
        // 插入时捕获真正写入数据库的图片，再让查询返回同一份资料。
        when(mapper.insertGroup(inserted.capture())).thenReturn(1);

        var result = new GroupService(mapper, Clock.systemUTC())
                .createGroup(user, new CreateGroupRequest(" 小队 ", " 描述 ", avatar));

        verify(mapper).insertGroup(any(ChatGroup.class));
        assertThat(result.avatar()).isEqualTo(inserted.getValue().avatar()).isNotEqualTo(avatar);
        byte[] storedBytes = Base64.getDecoder().decode(result.avatar().substring(result.avatar().indexOf(',') + 1));
        BufferedImage stored = ImageIO.read(new ByteArrayInputStream(storedBytes));
        assertThat(stored.getWidth()).isEqualTo(256);
        assertThat(stored.getRGB(0, 0) >>> 24).isZero();
    }

    @Test
    void shouldRejectDamagedAvatarBeforeWritingGroup() {
        GroupMapper mapper = mock(GroupMapper.class);
        GroupService service = new GroupService(mapper, Clock.systemUTC());
        AuthenticatedUser user = new AuthenticatedUser(UUID.randomUUID(), "群主", false);

        assertThatThrownBy(() -> service.createGroup(user,
                new CreateGroupRequest("小队", "", "data:image/png;base64,YWJj")))
                .isInstanceOf(GroupException.class).hasMessage("头像文件无效");
        verifyNoInteractions(mapper);
    }
}
