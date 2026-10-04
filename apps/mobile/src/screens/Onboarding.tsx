import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import type { Region } from '@civic-voice/sdk';
import { client, type Session } from '../storage.ts';
import { colors, styles } from '../theme.ts';

/**
 * Where do you live? A drill-down from state to ward, then registration. No name, phone or ID; the
 * demographic bands are asked for in the web app and are optional there too.
 */
export function Onboarding({ onDone }: { onDone: (session: Session) => void }) {
  const [trail, setTrail] = useState<Region[]>([]);
  const [options, setOptions] = useState<Region[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async (parentId: number) => {
    setOptions(null);
    try {
      setOptions((await client.childRegions(parentId)).items);
    } catch {
      setError('Could not load the list of areas.');
    }
  };

  useEffect(() => {
    void load(1);
  }, []);

  const register = async (region: Region) => {
    try {
      const result = await client.register({
        region_id: region.id,
        locale: 'en',
        demographics: {},
      });
      onDone({
        citizenId: result.citizen.id,
        regionId: region.id,
        regionName: region.name,
        regionPath: region.path,
      });
    } catch {
      setError('Could not create your account. Please try again.');
    }
  };

  const here = trail.at(-1);
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.h1}>Where do you live?</Text>
      <Text style={styles.meta}>
        This decides which decisions and local discussions are yours. We store no name, no phone
        number and no government ID.
      </Text>
      {trail.length > 0 && (
        <Text style={[styles.meta, { marginTop: 10 }]}>{trail.map((r) => r.name).join(' › ')}</Text>
      )}
      {here && (
        <Pressable style={[styles.primary, { marginTop: 12 }]} onPress={() => void register(here)}>
          <Text style={styles.primaryText}>I live in {here.name}</Text>
        </Pressable>
      )}
      {error && (
        <View style={styles.notice}>
          <Text style={styles.noticeText}>{error}</Text>
        </View>
      )}
      <View style={{ marginTop: 12 }}>
        {options === null ? (
          <ActivityIndicator color={colors.accent} />
        ) : (
          options.map((r) => (
            <Pressable
              key={r.id}
              style={styles.card}
              accessibilityRole="button"
              onPress={() => {
                setTrail([...trail, r]);
                void load(r.id);
              }}
            >
              <Text style={{ color: colors.text, fontSize: 15 }}>{r.name}</Text>
            </Pressable>
          ))
        )}
      </View>
    </ScrollView>
  );
}
