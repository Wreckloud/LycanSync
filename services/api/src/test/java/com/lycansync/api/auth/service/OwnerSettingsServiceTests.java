package com.lycansync.api.auth.service;

import com.lycansync.api.auth.config.AccountAccessProperties;
import com.lycansync.api.auth.config.QqLoginProperties;
import com.lycansync.api.auth.dto.QqConfigurationRequest;
import com.lycansync.api.auth.exception.AuthException;
import com.lycansync.api.auth.mapper.AccessLinkMapper;
import com.lycansync.api.auth.mapper.AuthMapper;
import com.lycansync.api.auth.mapper.QqConfigurationMapper;
import com.lycansync.api.auth.mapper.QqIdentityMapper;
import com.lycansync.api.auth.model.AuthenticatedUser;
import com.lycansync.api.auth.model.AuthUser;
import com.lycansync.api.auth.model.QqConfiguration;
import com.lycansync.api.rtc.config.LiveKitProperties;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.support.DefaultListableBeanFactory;

import java.time.Instant;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 服主 QQ 配置的生效来源、密钥保留和账号关联保护。
 *
 * @author Wreckloud
 * @since 2026-11-13
 */
class OwnerSettingsServiceTests {
    private final AuthMapper users = mock(AuthMapper.class);
    private final QqConfigurationMapper configurations = mock(QqConfigurationMapper.class);
    private final QqIdentityMapper identities = mock(QqIdentityMapper.class);
    private final AccessLinkMapper access = mock(AccessLinkMapper.class);
    private final QqLoginProperties defaults = new QqLoginProperties();
    private final QqConfigurationService qq = new QqConfigurationService(defaults, configurations);
    private final OwnerSettingsService service = new OwnerSettingsService(users, new AccountAccessProperties(), qq,
            configurations, identities, access, new DefaultListableBeanFactory().getBeanProvider(LiveKitProperties.class));
    private final AuthenticatedUser owner = new AuthenticatedUser(UUID.randomUUID(), "服主", true);
    private static final String CALLBACK = "https://example.com/api/auth/qq/callback";

    @BeforeEach
    void setup() {
        when(users.findUserProfile(owner.id())).thenReturn(new AuthUser(owner.id(), "服主", "", true, "", Instant.now()));
        when(access.lockInitialization()).thenReturn(true);
        when(configurations.save(any())).thenReturn(1);
    }

    @Test
    void savedConfigurationOverridesDeploymentIncludingDisabledState() {
        defaults.setEnabled(true);
        defaults.setAppId("1234567"); defaults.setAppKey("deployment-key"); defaults.setCallbackUrl(CALLBACK);
        assertThat(qq.isEnabled()).isTrue();
        var saved = new QqConfiguration(false, "7654321", "saved-key", CALLBACK);
        when(configurations.find()).thenReturn(saved);
        assertThat(qq.current()).isEqualTo(saved);
        assertThat(service.status(owner).qqEnabled()).isFalse();
    }

    @Test
    void saveEnablesLoginWithoutReturningKeyAndBlankKeyRetainsExistingSecret() {
        when(configurations.find()).thenReturn(new QqConfiguration(true, "1234567", "private-key", CALLBACK));
        var result = service.saveQqSettings(owner, new QqConfigurationRequest(true, "1234567", "", CALLBACK));
        verify(configurations).save(new QqConfiguration(true, "1234567", "private-key", CALLBACK));
        assertThat(result.appKeyConfigured()).isTrue();
        assertThat(result.toString()).doesNotContain("private-key");
    }

    @Test
    void changedApplicationDoesNotInheritOldSecret() {
        when(configurations.find()).thenReturn(new QqConfiguration(true, "1234567", "private-key", CALLBACK));
        assertThatThrownBy(() -> service.saveQqSettings(owner, new QqConfigurationRequest(true, "7654321", "", CALLBACK)))
                .isInstanceOf(AuthException.class);
        verify(configurations, never()).save(any());
    }

    @Test
    void boundAccountsPreventChangingOrClearingApplicationId() {
        when(identities.hasOtherApplication("7654321")).thenReturn(true);
        assertThatThrownBy(() -> service.saveQqSettings(owner, new QqConfigurationRequest(true, "7654321", "new-key", CALLBACK)))
                .isInstanceOf(AuthException.class).hasMessageContaining("已有成员绑定");
        verify(configurations, never()).save(any());
    }

    @Test
    void disablingRetainsApplicationForExistingMembers() {
        when(configurations.find()).thenReturn(new QqConfiguration(true, "1234567", "private-key", CALLBACK));
        service.saveQqSettings(owner, new QqConfigurationRequest(false, "1234567", "", CALLBACK));
        verify(configurations).save(new QqConfiguration(false, "1234567", "private-key", CALLBACK));
    }

    @Test
    void rejectsInvalidCallbackWithoutEchoingSecrets() {
        for (String callback : new String[]{"http://example.com/api/auth/qq/callback", "https://example.com/other",
                "https://user:secret@example.com/api/auth/qq/callback", CALLBACK + "?secret=value"}) {
            assertThatThrownBy(() -> service.saveQqSettings(owner, new QqConfigurationRequest(true, "1234567", "private-key", callback)))
                    .isInstanceOf(AuthException.class).hasMessageNotContaining("private-key").hasMessageNotContaining("secret=value");
        }
        verify(configurations, never()).save(any());
    }

    @Test
    void transferDuringSaveIsRejectedAfterLock() {
        when(users.findUserProfile(owner.id())).thenReturn(new AuthUser(owner.id(), "服主", "", true, "", Instant.now()),
                new AuthUser(owner.id(), "原服主", "", false, "", Instant.now()));
        assertThatThrownBy(() -> service.saveQqSettings(owner, new QqConfigurationRequest(true, "1234567", "key", CALLBACK)))
                .isInstanceOf(AuthException.class).hasMessageContaining("只有当前服主");
        verify(configurations, never()).save(any());
    }

    @Test
    void failedWriteDoesNotReportSuccess() {
        when(configurations.save(any())).thenReturn(0);
        assertThatThrownBy(() -> service.saveQqSettings(owner, new QqConfigurationRequest(true, "1234567", "key", CALLBACK)))
                .isInstanceOf(IllegalStateException.class);
    }
}
