/**
 * DEMO CONTENT — invented comments from simulated residents, for the in-memory development stack
 * only (`pnpm dev:demo`). Nothing here is anyone's opinion. It exists so the discussion pages,
 * digests and cohort insights have something to render while the UI is being built, and it runs with
 * CIVIC_DEMO=1, which puts a banner on every page saying so.
 *
 * Never load this into a real database.
 */

export interface DemoResident {
  regionKey: string;
  demographics: Record<string, string>;
  /** Comments as [topic matcher, text]. The matcher picks a topic by title substring. */
  comments: Array<[string, string]>;
}

const youthCity: Array<[string, string]> = [
  [
    'storm water drains',
    'Every monsoon our street in Khairatabad floods knee-deep. Please desilt the drains before June, not after.',
  ],
  [
    'storm water drains',
    'Rs 1,250 crore is a lot of money. Publish ward-wise work lists and completion dates so we can check.',
  ],
  [
    'storm water drains',
    'Good decision, finally. But last year the nala work near our college stopped halfway.',
  ],
  [
    'Metro phase-II',
    'Metro to the airport will help students and job seekers who travel to interviews. Please add feeder buses.',
  ],
  [
    'Metro phase-II',
    'We need metro to Gachibowli IT area more than the airport. Most young people work there.',
  ],
  [
    'Metro phase-II',
    'Construction will block roads for three years. Plan diversions properly this time.',
  ],
  [
    'Waterlogging',
    'Ameerpet coaching centres flooded again, students waded through dirty water to reach classes.',
  ],
  [
    'Waterlogging',
    'Garbage blocks the drains, that is why it floods. Clear it regularly and fine the dumpers.',
  ],
  [
    'Waterlogging',
    'Why is there no warning system? Send SMS alerts before heavy rain so people can avoid these roads.',
  ],
  [
    'Uppal flyover',
    'Two years of traffic jams on this stretch. Finish the flyover, commuters are losing hours every day.',
  ],
  [
    'Uppal flyover',
    'The service road is full of potholes. At least repair it until the flyover is done.',
  ],
  [
    'Heavy rain',
    'IT companies should allow work from home on heavy rain days. Gachibowli becomes a lake.',
  ],
  ['Heavy rain', 'Madhapur underpass floods every year. Build a proper pumping station there.'],
  [
    'Re-carpeting',
    'Good that roads in Ward 91 are being relaid. Please also fix the streetlights on the lake road.',
  ],
  [
    'Jal Jeevan',
    'Tap connections are good but water comes only one hour a day in our area. Supply hours matter.',
  ],
  [
    'Kharif',
    'My parents are farmers in Nalgonda. MSP increase is small compared to fertiliser and diesel prices.',
  ],
  [
    'storm water drains',
    'మా కాలనీలో ప్రతి వర్షానికి నీళ్లు ఇళ్లలోకి వస్తున్నాయి. డ్రైనేజీ పనులు త్వరగా పూర్తి చేయాలి.',
  ],
  ['Metro phase-II', 'Metro ki fare kam rakhna chahiye, students ke liye pass hona chahiye.'],
  [
    'Waterlogging',
    'Bahut bura haal hai, har saal yahi hota hai. Naukri ke interview ke liye bhi nahi ja paaye.',
  ],
  [
    'Uppal flyover',
    'Please publish the contractor name and the penalty for delay. Accountability is needed.',
  ],
  [
    'Heavy rain',
    'Power cuts during rain make online classes impossible. Need underground cabling.',
  ],
  [
    'Metro phase-II',
    'Jobs for local youth in metro construction and operations, please. Not only contractors from outside.',
  ],
  [
    'storm water drains',
    'Employment guarantee for urban youth could be linked to drain cleaning work. Win-win.',
  ],
  [
    'Re-carpeting',
    'Roads get dug up again one month after relaying because of pipelines. Coordinate the departments.',
  ],
  [
    'Heavy rain',
    'Hostels for students near Madhapur had no power for 12 hours. Nobody from the corporation came.',
  ],
  [
    'Waterlogging',
    'We need more government jobs notifications, not only promises. Group-IV exam delayed again.',
  ],
  [
    'Metro phase-II',
    'Airport metro is fine but first increase frequency on existing lines during peak hours.',
  ],
  [
    'Uppal flyover',
    'Pedestrian crossing near Uppal is dangerous for students. Build a foot overbridge.',
  ],
  [
    'Jal Jeevan',
    'Water tanker mafia charges Rs 800 per tanker in our area. Piped supply must reach everyone.',
  ],
  [
    'Heavy rain',
    'Thank you to the disaster response team, they cleared the fallen tree on our road quickly.',
  ],
];

const farmersState: Array<[string, string]> = [
  [
    'Rythu Bharosa',
    'Rythu Bharosa money has not reached my account for two seasons. Tenant farmers are left out completely.',
  ],
  [
    'Rythu Bharosa',
    'Assistance should be released before sowing, not after harvest. We borrow at high interest meanwhile.',
  ],
  [
    'Rythu Bharosa',
    'Good that the scheme continues. Include tenant farmers, they do the actual cultivation.',
  ],
  [
    'Kharif',
    'Paddy MSP increase does not cover cost of cultivation. Diesel, labour and fertiliser all went up.',
  ],
  [
    'Kharif',
    'Procurement centres must open on time. Last year we sold to middlemen below MSP because centres opened late.',
  ],
  [
    'Kharif',
    'MSP is announced but mills cut weight and moisture. Farmers do not actually get the MSP.',
  ],
  [
    'Jal Jeevan',
    'Drinking water in our village is fluoride affected. Tap connection is there but water quality is bad.',
  ],
  [
    'Jal Jeevan',
    'Pipeline laid but water never came. Please check village by village, not only on paper.',
  ],
  ['Rythu Bharosa', 'రైతు భరోసా డబ్బులు ఇంకా రాలేదు. కౌలు రైతులకు కూడా ఇవ్వాలి.'],
  ['Kharif', 'మద్దతు ధర పెంపు సరిపోదు. ఎరువుల ధరలు రెట్టింపు అయ్యాయి.'],
  ['Kharif', 'Kisan ko sahi daam nahi milta, mandi mein bichauliye sab kha jaate hain.'],
  [
    'Rythu Bharosa',
    'Crop insurance claims pending for a year after the floods. Please settle them.',
  ],
  [
    'Jal Jeevan',
    'Irrigation water is more urgent than tap water for us. Canal lining is incomplete for years.',
  ],
  [
    'Kharif',
    'Need cold storage and a food processing unit in our mandal so we can hold crop and sell later.',
  ],
  [
    'Rythu Bharosa',
    'Online application portal does not work in our village. Keep the agriculture office counter open.',
  ],
  [
    'Kharif',
    'Free power for agriculture is only 7 hours at night. Farmers get snake bites irrigating in the dark.',
  ],
  [
    'Jal Jeevan',
    'Our village borewells dried up. Groundwater recharge projects are needed before more pipelines.',
  ],
  [
    'Rythu Bharosa',
    'Loan waiver was announced but bank still shows my loan outstanding. Nobody answers.',
  ],
  [
    'Kharif',
    'Soil testing and good seeds at subsidised rates would help more than small MSP hikes.',
  ],
  ['Rythu Bharosa', 'Give the assistance per acre actually cultivated, not per pattadar passbook.'],
  [
    'Kharif',
    'Cotton farmers also need support, not only paddy. Pink bollworm destroyed half our crop.',
  ],
  [
    'Jal Jeevan',
    'Women walk 2 km for water in summer. Please complete the overhead tank in our village.',
  ],
  ['Rythu Bharosa', 'Transparent list of beneficiaries should be displayed at the gram panchayat.'],
  ['Kharif', 'MSP should be legally guaranteed. Announcements alone do not help small farmers.'],
  [
    'Rythu Bharosa',
    'Young people are leaving farming because there is no income. Support farm mechanisation.',
  ],
  ['Kharif', 'Weather based advisory on phone in Telugu would help us plan sowing.'],
  [
    'Jal Jeevan',
    'Water supply is good now in our village, thank you. Maintain the pumps regularly.',
  ],
  [
    'Kharif',
    'Fertiliser shortage during peak season every year. Stock it in advance at cooperative societies.',
  ],
];

const others: Array<[string, string]> = [
  [
    'storm water drains',
    'Senior citizens in our lane cannot step out for days when it floods. Please prioritise old localities.',
  ],
  [
    'storm water drains',
    'Encroachments on nalas must be removed first, otherwise new drains will also overflow.',
  ],
  [
    'Metro phase-II',
    'Good long-term decision for the city. Keep fares affordable for daily wage workers.',
  ],
  [
    'Waterlogging',
    'Hospital near Ameerpet had water inside the ground floor. Emergency services need dry access.',
  ],
  [
    'Uppal flyover',
    'Auto drivers lost income because of the diversions. Some compensation or support is needed.',
  ],
  ['Jal Jeevan', 'The scheme works well in our district, most houses have taps now.'],
  [
    'Heavy rain',
    'Old buildings collapse in heavy rain. Survey dilapidated structures before the monsoon.',
  ],
  [
    'Re-carpeting',
    'Quality of the new road is poor, the top layer is already coming off near the bus stop.',
  ],
];

function residents(
  comments: Array<[string, string]>,
  regionKeys: string[],
  demographics: (i: number) => Record<string, string>,
): DemoResident[] {
  return comments.map((c, i) => ({
    regionKey: regionKeys[i % regionKeys.length] as string,
    demographics: demographics(i),
    comments: [c],
  }));
}

const wards = [
  'IN-TG-GHMC-khairatabad',
  'IN-TG-GHMC-ameerpet',
  'IN-TG-GHMC-uppal',
  'IN-TG-GHMC-gachibowli',
  'IN-TG-GHMC-madhapur',
  'IN-TG-GHMC-kukatpally',
];

export const DEMO_RESIDENTS: DemoResident[] = [
  ...residents(youthCity, wards, (i) => ({
    age_band: i % 3 === 0 ? '25-34' : '18-24',
    occupation_band: i % 2 === 0 ? 'student' : 'salaried_private',
    gender: ['female', 'male'][i % 2] as string,
    urbanity: 'urban',
  })),
  ...residents(farmersState, ['IN-TG'], (i) => ({
    age_band: ['35-44', '45-54', '25-34', '55-64'][i % 4] as string,
    occupation_band: 'agriculture',
    gender: ['male', 'female', 'male'][i % 3] as string,
    urbanity: 'rural',
  })),
  ...residents(others, wards, (i) => ({
    age_band: ['45-54', '55-64', '65+', '35-44'][i % 4] as string,
    occupation_band: ['self_employed', 'retired_other', 'homemaker', 'government'][i % 4] as string,
    urbanity: 'urban',
  })),
];

export const DEMO_ISSUES: Array<{
  regionKey: string;
  title: string;
  details: string;
  scope: 'ward' | 'city';
}> = [
  {
    regionKey: 'IN-TG-GHMC-kukatpally',
    title: 'Power cuts every evening in Kukatpally during exam season',
    details: 'Students cannot study after 7 pm; the substation near the bus depot trips daily.',
    scope: 'ward',
  },
  {
    regionKey: 'IN-TG-GHMC-gachibowli',
    title: 'No city buses to Gachibowli after 10 pm for shift workers',
    details:
      'IT and hospital staff finishing late shifts pay for autos every night. A late-night route would help thousands.',
    scope: 'city',
  },
];
