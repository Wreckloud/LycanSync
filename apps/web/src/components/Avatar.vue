<script setup lang="ts">
import { UserRound } from '@lucide/vue';

defineOptions({ inheritAttrs: false });
withDefaults(defineProps<{ src?: string; iconSize?: number; placeholderClass?: string }>(), { iconSize: 22 });
</script>

<template>
  <img v-if="src" :src="src" alt="" v-bind="$attrs" />
  <span v-else-if="placeholderClass" :class="placeholderClass" v-bind="$attrs"><UserRound :size="iconSize" aria-hidden="true" /></span>
  <UserRound v-else :size="iconSize" aria-hidden="true" v-bind="$attrs" />
</template>
